/**
 * Sender-side helper for the popup <-> background messaging (§P1). Never
 * throws — a failed send is a logged, `null`-returning event (§7.2), and
 * the caller decides how to degrade (e.g. the popup shows "unknown"
 * rather than crashing its own render).
 */

import type { TradePilotRequest, TradePilotResponse } from './messages';
import { getLogger } from '../../utils/logger';

const log = getLogger('messaging:bus');

export async function sendToBackground<T extends TradePilotResponse>(
  message: TradePilotRequest,
): Promise<T | null> {
  try {
    const response: unknown = await chrome.runtime.sendMessage(message);
    return (response as T) ?? null;
  } catch (error) {
    log.warn('sendToBackground failed', { messageType: message.type, error: String(error) });
    return null;
  }
}
