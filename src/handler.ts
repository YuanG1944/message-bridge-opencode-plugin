import type { TextPartInput } from '@opencode-ai/sdk';
import type { OpenCodeApi } from './opencode';
import type { FeishuClient } from './feishu';
import { LOADING_EMOJI } from './constants';

const sessionMap = new Map<string, string>();

// Exporting this map so index.ts can check permissions based on session ownership
export const sessionOwnerMap = new Map<string, string>();

export const createMessageHandler = (api: OpenCodeApi, feishu: FeishuClient) => {
  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] Handling message from User: ${senderId} | Chat: ${chatId}`);

    if (text.trim().toLowerCase() === 'ping') {
      await feishu.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    let reactionId: string | null = null;
    if (messageId) {
      reactionId = await feishu.addReaction(messageId, LOADING_EMOJI);
    }

    try {
      let sessionId = sessionMap.get(chatId);

      if (!sessionId) {
        const uniqueSessionTitle = `[Feishu] ${chatId}`;
        console.log(
          `[Bridge] Session not found in cache. Searching/Creating for title: "${uniqueSessionTitle}"...`,
        );

        try {
          if (api.getSessionList) {
            const listRes = await api.getSessionList({});

            const sessions = Array.isArray(listRes) ? listRes : listRes.data || [];
            const existSession = sessions.find((s: any) => s.title === uniqueSessionTitle);

            if (existSession) {
              sessionId = existSession.id;
              console.log(`[Bridge] ♻️ Reusing existing session: ${sessionId}`);
            }
          }
        } catch (e) {
          console.warn(
            '[Bridge] Failed to retrieve session list, proceeding to create new session.',
            e,
          );
        }

        if (!sessionId) {
          try {
            if (!api.createSession) throw new Error('SDK Method: sessionCreate not found');

            const reqData = {
              body: {
                title: uniqueSessionTitle,
                mode: 'plan',
              },
            };

            const res = await api.createSession(reqData);
            sessionId = res.id || res.data?.id;

            if (sessionId) {
              console.log(`[Bridge] ✨ Created new session: ${sessionId}`);
            }
          } catch (err) {
            console.error('[Bridge] Create Session Failed:', err);
            await feishu.sendMessage(chatId, '❌ Failed to create session');
            return;
          }
        }

        if (sessionId) {
          sessionMap.set(chatId, sessionId);
          sessionOwnerMap.set(sessionId, senderId);
        }
      } else {
        // Update owner map even on cache hit to ensure permission check works after restart/reconnect
        sessionOwnerMap.set(sessionId, senderId);
      }

      console.log(
        `[Bridge] 🚀 Sending prompt to OpenCode: "${text.length > 50 ? text.substring(0, 50) + '...' : text}"`,
      );
      const parts: TextPartInput[] = [{ type: 'text', text: text }];

      try {
        if (!api.promptSession) throw new Error('SDK Method: sessionPrompt not found');

        await api.promptSession({
          path: { id: sessionId! },
          body: { parts: parts },
        });
      } catch (sendErr: any) {
        console.error('[Bridge] ❌ API Prompt Error:', sendErr);

        if (JSON.stringify(sendErr).includes('404') || sendErr.status === 404) {
          sessionMap.delete(chatId);
          await feishu.sendMessage(
            chatId,
            '⚠️ Session expired or invalid. Resetting connection. Please try again.',
          );
        } else {
          await feishu.sendMessage(
            chatId,
            `❌ Send Failed: ${sendErr.message || 'Unknown API Error'}`,
          );
        }
        return;
      }

      if (!api.getMessages) return;

      console.log(`[Bridge] ⏳ Polling for response (Session: ${sessionId})...`);

      let attempts = 0;
      const maxAttempts = 60;

      await new Promise<void>(resolve => {
        const pollTimer = setInterval(async () => {
          attempts++;
          if (attempts > maxAttempts) {
            clearInterval(pollTimer);
            console.warn('[Bridge] Polling timed out.');
            await feishu.sendMessage(chatId, '❌ AI Response Timeout');
            resolve();
            return;
          }

          try {
            await api
              .getMessages({
                path: { id: sessionId! },
                query: { limit: 10 } as any,
              })
              .then((res: any) => {
                const messages = Array.isArray(res) ? res : res.data || [];
                if (messages.length === 0) return;

                const lastItem = messages[messages.length - 1];
                const info = lastItem.info;

                if (info.role === 'assistant' && !info.error) {
                  clearInterval(pollTimer);

                  let replyText = '';
                  if (lastItem.parts && lastItem.parts.length > 0) {
                    replyText = lastItem.parts
                      .filter((p: any) => p.type === 'text')
                      .map((p: any) => p.text)
                      .join('\n')
                      .trim();
                  }

                  console.log(`[Bridge] ✅ Response received (${replyText.length} chars)`);
                  feishu.sendMessage(chatId, replyText || '(AI response was empty)');
                  resolve();
                } else if (info.error) {
                  clearInterval(pollTimer);
                  const errMsg = typeof info.error === 'string' ? info.error : info.error.message;
                  console.error('[Bridge] AI Error:', info.error);
                  feishu.sendMessage(chatId, `❌ AI Error: ${errMsg}`);
                  resolve();
                }
              });
          } catch (e) {
            // silent retry
          }
        }, 1500);
      });
    } catch (error: any) {
      console.error('[Bridge] Fatal Logic Error:', error);
      await feishu.sendMessage(chatId, `❌ System Error: ${error.message}`);
    } finally {
      if (messageId && reactionId) {
        await feishu.removeReaction(messageId, reactionId);
      }
    }
  };
};
