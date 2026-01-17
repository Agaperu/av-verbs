const rawBase = import.meta.env.VITE_API_BASE_URL || '';
const base = rawBase.replace(/\/+$/, '');

export const API_BASE_URL = base;
export const API_CHAT_URL = `${base}/api/openai-chat`;
