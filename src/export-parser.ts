import crypto from 'crypto';
import type { Message } from './line-client';

export function parseExportHeader(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  const match = firstLine.match(/^Chat history with (.+)$/);
  if (!match) throw new Error('File does not appear to be a LINE chat export.');
  return match[1].trim();
}

// Converts a local date/time in the given IANA timezone to UTC milliseconds.
// Uses the Intl.DateTimeFormat offset-estimation technique (no external deps).
function localToUtcMs(
  year: number, month: number, day: number,
  hour: number, minute: number,
  timezone: string,
): number {
  // Treat local time as UTC to get a rough candidate
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Format that UTC instant in the target timezone to measure the actual offset
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  }).formatToParts(new Date(guess));
  const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value, 10);
  const renderedMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), 0);
  // Offset correction: utc = 2*guess - renderedMs  (exact for non-DST-gap instants)
  return 2 * guess - renderedMs;
}

function syntheticId(
  chatMid: string, dateStr: string, timeStr: string, senderName: string, text: string,
): string {
  return 'export-' + crypto
    .createHash('sha256')
    .update(chatMid + dateStr + timeStr + senderName + text)
    .digest('hex')
    .slice(0, 24);
}

const DAY_RE = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MSG_RE = /^(\d{2}:\d{2})\t(.+?)\t(.*)$/;

interface Pending {
  dateStr: string; timeStr: string;
  year: number; month: number; day: number;
  hour: number; minute: number;
  senderName: string;
  textLines: string[];
}

export function parseExportFile(text: string, chatMid: string, timezone: string): Message[] {
  const lines = text.split('\n');
  const messages: Message[] = [];
  let currentDate: { year: number; month: number; day: number } | null = null;
  let pending: Pending | null = null;

  function flush(): void {
    if (!pending) return;
    const msgText = pending.textLines.join('\n').trimEnd();
    messages.push({
      id: syntheticId(chatMid, pending.dateStr, pending.timeStr, pending.senderName, msgText),
      from: `export:${pending.senderName}`,
      senderName: pending.senderName,
      to: chatMid,
      toType: 0,
      createdTime: String(localToUtcMs(pending.year, pending.month, pending.day, pending.hour, pending.minute, timezone)),
      contentType: 0,
      text: msgText,
      hasContent: false,
    });
    pending = null;
  }

  for (const line of lines) {
    const dayMatch = line.match(DAY_RE);
    if (dayMatch) {
      flush();
      currentDate = { month: parseInt(dayMatch[1], 10), day: parseInt(dayMatch[2], 10), year: parseInt(dayMatch[3], 10) };
      continue;
    }

    const msgMatch = line.match(MSG_RE);
    if (msgMatch && currentDate) {
      flush();
      const [, timeStr, senderName, firstText] = msgMatch;
      const [hh, mm] = timeStr.split(':').map(Number);
      pending = {
        dateStr: `${currentDate.month}/${currentDate.day}/${currentDate.year}`,
        timeStr,
        ...currentDate,
        hour: hh,
        minute: mm,
        senderName,
        textLines: [firstText],
      };
      continue;
    }

    // Non-matching lines with no pending message: file header, blank lines between days — ignore
    if (!pending) continue;
    // Blank or continuation lines within a message — preserve
    pending.textLines.push(line);
  }
  flush();

  return messages;
}
