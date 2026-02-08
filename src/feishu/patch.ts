import axios from 'axios';

export interface FeishuResourceResponse {
  buffer: Buffer;
  headers: Record<string, unknown>;
  mime?: string;
}

type FeishuUploadResponse = {
  code?: number;
  msg?: string;
  image_key?: string;
  file_key?: string;
  data?: {
    image_key?: string;
    file_key?: string;
  };
};

type FeishuHttpError = Error & {
  response?: {
    status: number;
    data: string;
  };
};

// 原生sdk总是超时，直接使用url调用
export async function fetchFeishuResourceToBuffer(params: {
  messageId: string;
  fileKey: string;
  msgType: string;
  maxBytes: number;
  tenantToken: string;
  timeoutMs?: number;
}): Promise<FeishuResourceResponse> {
  const { messageId, fileKey, msgType, maxBytes, tenantToken, timeoutMs = 120000 } = params;
  const url = new URL(
    `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${encodeURIComponent(
      msgType,
    )}`,
  );

  const res = await axios.get(url.toString(), {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    headers: {
      Authorization: `Bearer ${tenantToken}`,
    },
    validateStatus: () => true,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const headers = res.headers || {};
  const status = res.status || 0;
  if (status < 200 || status >= 300) {
    const body =
      res.data && Buffer.isBuffer(res.data)
        ? res.data.toString('utf8')
        : JSON.stringify(res.data || '');
    const err: FeishuHttpError = new Error(`HTTP ${status}: ${body}`);
    err.response = { status, data: body };
    throw err;
  }

  const contentLengthRaw = headers['content-length'];
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;
  if (contentLength && contentLength > maxBytes) {
    throw new Error('Content too large');
  }

  const buffer: Buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || '');
  if (buffer.length > maxBytes) {
    throw new Error('Content too large');
  }

  const contentType = headers['content-type'];
  const contentTypeText = Array.isArray(contentType) ? contentType[0] : contentType;
  const mime =
    typeof contentTypeText === 'string' ? contentTypeText.split(';')[0]?.trim() : undefined;

  return { buffer, headers, mime };
}

async function parseUploadResponse(resp: Response): Promise<FeishuUploadResponse> {
  const text = await resp.text();
  try {
    return JSON.parse(text) as FeishuUploadResponse;
  } catch {
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
}

export async function uploadFeishuImageBuffer(params: {
  tenantToken: string;
  buffer: Buffer;
  filename: string;
  timeoutMs?: number;
}): Promise<string> {
  const { tenantToken, buffer, filename, timeoutMs = 120000 } = params;
  const url = 'https://open.feishu.cn/open-apis/im/v1/images';
  const form = new FormData();
  form.append('image_type', 'message');
  form.append(
    'image',
    new Blob([new Uint8Array(buffer)], { type: 'application/octet-stream' }),
    filename,
  );

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}` },
      body: form,
      signal: ctrl.signal,
    });
    const body = await parseUploadResponse(resp);
    if (!resp.ok || body.code !== 0) {
      throw new Error(
        `upload image failed: status=${resp.status} code=${body.code ?? '-'} msg=${body.msg || '-'}`,
      );
    }
    const imageKey = body.image_key || body.data?.image_key;
    if (!imageKey) throw new Error('upload image failed: missing image_key');
    return imageKey;
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadFeishuFileBuffer(params: {
  tenantToken: string;
  buffer: Buffer;
  filename: string;
  fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
  timeoutMs?: number;
}): Promise<string> {
  const { tenantToken, buffer, filename, fileType, timeoutMs = 120000 } = params;
  const url = 'https://open.feishu.cn/open-apis/im/v1/files';
  const form = new FormData();
  form.append('file_type', fileType);
  form.append('file_name', filename);
  form.append(
    'file',
    new Blob([new Uint8Array(buffer)], { type: 'application/octet-stream' }),
    filename,
  );

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}` },
      body: form,
      signal: ctrl.signal,
    });
    const body = await parseUploadResponse(resp);
    if (!resp.ok || body.code !== 0) {
      throw new Error(
        `upload file failed: status=${resp.status} code=${body.code ?? '-'} msg=${body.msg || '-'}`,
      );
    }
    const fileKey = body.file_key || body.data?.file_key;
    if (!fileKey) throw new Error('upload file failed: missing file_key');
    return fileKey;
  } finally {
    clearTimeout(timer);
  }
}
