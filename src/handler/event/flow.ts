import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AdapterMux } from '../mux';
import { bridgeLogger } from '../../logger';
import type { EventFlowDeps } from './types';
import {
  dispatchEventByType,
  flushAllEvents,
  resetEventDispatchState,
} from './dispatch';
import { summarizeObservedEvent, unwrapObservedEvent } from './utils';
import * as fs from 'node:fs';

export type { EventFlowDeps } from './types';

export async function startGlobalEventListenerWithDeps(
  api: OpencodeClient,
  mux: AdapterMux,
  deps: EventFlowDeps
) {
  if (deps.listenerState.isListenerStarted) {
    bridgeLogger.debug('[BridgeFlowDebug] listener already started, skip');
    return;
  }
  deps.listenerState.isListenerStarted = true;
  deps.listenerState.shouldStopListener = false;

  bridgeLogger.info('[Listener] starting global event subscription (MUX)');

  let retryCount = 0;
  let globalRetryCount = 0;
  const degradedRaw = Number(process.env.BRIDGE_MAIN_EVENT_DEGRADED_MS);
  const mainDegradedThresholdMs =
    Number.isFinite(degradedRaw) && degradedRaw > 0 ? degradedRaw : 30_000;
  let lastMainRichEventAt = Date.now();
  let globalFallbackAnnounced = false;
  const currentDir = process.cwd();
  const currentDirReal = (() => {
    try {
      return fs.realpathSync(currentDir);
    } catch {
      return currentDir;
    }
  })();

  const normalizeDir = (dir: string): string => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  };

  const isSameProjectDir = (dir?: string): boolean => {
    if (!dir) return true;
    const normalized = normalizeDir(dir);
    if (normalized === currentDirReal) return true;
    // Fallback comparison when one side contains symlinked segments.
    return normalized === currentDir || dir === currentDir || dir === currentDirReal;
  };

  const GLOBAL_FORWARD_EVENT_TYPES = new Set<string>([
    'permission.updated',
    'permission.asked',
    'permission.replied',
    'question.asked',
    'question.replied',
    'question.rejected',
  ]);

  const connect = async () => {
    let streamWatchdog: NodeJS.Timeout | undefined;
    const resetWatchdog = () => {
      if (streamWatchdog) clearTimeout(streamWatchdog);
      streamWatchdog = setTimeout(() => {
        bridgeLogger.warn('[Listener] no events received for 60s, reconnecting...');
        deps.listenerState.shouldStopListener = true; // Trigger break in loop
      }, 60000);
    };

    try {
      // Explicitly pass directory to ensure we get events for the current project
      const events = await api.event.subscribe({ query: { directory: currentDirReal } });
      bridgeLogger.info(`[Listener] connected to OpenCode event stream (dir=${currentDirReal})`);
      retryCount = 0;
      resetWatchdog();

      for await (const event of events.stream) {
        resetWatchdog();
        // Log raw event type if possible for deep diagnosis
        const rawType = (event as any)?.type || (event as any)?.payload?.type || 'unknown';
        bridgeLogger.debug(`[BridgeFlowDebug] raw event received type=${rawType}`);

        const e = unwrapObservedEvent(event);
        if (deps.listenerState.shouldStopListener) {
          deps.listenerState.shouldStopListener = false; // Reset for next connect
          break;
        }
        if (!e) {
          bridgeLogger.debug('[BridgeFlow] event.observed.unparsed', event);
          continue;
        }
        if (e.type !== 'server.heartbeat' && e.type !== 'server.connected') {
          lastMainRichEventAt = Date.now();
          globalFallbackAnnounced = false;
        }
        bridgeLogger.info('[BridgeFlow] event.observed', summarizeObservedEvent(e));
        await dispatchEventByType(e, api, mux, deps);
      }

      await flushAllEvents(mux, deps);
      if (streamWatchdog) clearTimeout(streamWatchdog);
    } catch (e) {
      if (streamWatchdog) clearTimeout(streamWatchdog);
      if (deps.listenerState.shouldStopListener) return;

      bridgeLogger.error('[Listener] stream disconnected', e);
      await flushAllEvents(mux, deps);

      const delay = Math.min(5000 * (retryCount + 1), 60000);
      retryCount++;
      setTimeout(connect, delay);
    }
  };

  const connectGlobalPermissions = async () => {
    if (!api.global?.event) return;
    let globalStreamWatchdog: NodeJS.Timeout | undefined;
    const resetGlobalWatchdog = () => {
      if (globalStreamWatchdog) clearTimeout(globalStreamWatchdog);
      globalStreamWatchdog = setTimeout(() => {
        bridgeLogger.warn('[Listener] no global events received for 60s, reconnecting...');
        deps.listenerState.shouldStopListener = true;
      }, 60000);
    };

    try {
      const events = await api.global.event();
      bridgeLogger.info('[Listener] connected to OpenCode global event stream');
      globalRetryCount = 0;
      resetGlobalWatchdog();

      for await (const event of events.stream) {
        resetGlobalWatchdog();
        const rawType = (event as any)?.type || (event as any)?.payload?.type || 'unknown';
        bridgeLogger.debug(`[BridgeFlowDebug] raw global event received type=${rawType}`);

        const directory =
          event && typeof event === 'object' && typeof (event as { directory?: unknown }).directory === 'string'
            ? ((event as { directory?: string }).directory as string)
            : undefined;
        if (!isSameProjectDir(directory)) continue;

        const e = unwrapObservedEvent(event);
        if (deps.listenerState.shouldStopListener) break;
        if (!e) continue;

        let shouldForward = GLOBAL_FORWARD_EVENT_TYPES.has(e.type);
        if (!shouldForward && e.type !== 'server.heartbeat' && e.type !== 'server.connected') {
          shouldForward = Date.now() - lastMainRichEventAt >= mainDegradedThresholdMs;
          if (shouldForward && !globalFallbackAnnounced) {
            bridgeLogger.warn(
              `[Listener] main event stream appears degraded; enabling global fallback after ${mainDegradedThresholdMs}ms of heartbeat-only traffic`
            );
            globalFallbackAnnounced = true;
          }
        }
        if (!shouldForward) continue;
        await dispatchEventByType(e, api, mux, deps);
      }
      if (globalStreamWatchdog) clearTimeout(globalStreamWatchdog);
    } catch (e) {
      if (globalStreamWatchdog) clearTimeout(globalStreamWatchdog);
      if (deps.listenerState.shouldStopListener) return;
      bridgeLogger.error('[Listener] global stream disconnected', e);
      const delay = Math.min(5000 * (globalRetryCount + 1), 60000);
      globalRetryCount++;
      setTimeout(connectGlobalPermissions, delay);
    }
  };

  connect();
  connectGlobalPermissions();
}

export function stopGlobalEventListenerWithDeps(deps: EventFlowDeps) {
  deps.listenerState.shouldStopListener = true;
  deps.listenerState.isListenerStarted = false;
  resetEventDispatchState(deps);
}
