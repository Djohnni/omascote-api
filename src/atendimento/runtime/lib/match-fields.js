// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitMatchup = splitMatchup;
exports.joinMatchup = joinMatchup;
exports.splitScore = splitScore;
exports.joinScore = joinScore;
exports.resolveMatchDate = resolveMatchDate;
exports.formatMatchDateInput = formatMatchDateInput;
exports.matchDateForDraft = matchDateForDraft;
// Keep the stored briefing compatible with chat/print extraction and existing orders.
function splitMatchup(value) {
    // The form stores the two editable fields as "Time A x Time B". Match that
    // exact separator first so a trailing space typed in Time A is not swallowed
    // by the more permissive legacy parser during the controlled-input rerender.
    const canonical = value.match(/^(.*?) x (.*)$/i);
    if (canonical)
        return { home: canonical[1], away: canonical[2] };
    const parts = value.split(/\s+[x×]\s+|\s+vs\.?\s+/i);
    return { home: parts[0] || '', away: parts.slice(1).join(' x ') };
}
function joinMatchup(home, away) { return `${home} x ${away}`; }
function splitScore(value) {
    const victory = value.trim().match(/^(.+?)\s+venceu\s+(.+?)\s+por\s+(\d+)\s+a\s+(\d+)\.?$/i);
    if (victory)
        return { home: victory[1], homeScore: victory[3], awayScore: victory[4], away: victory[2] };
    // Preserve spaces in Time A when reading back the exact string emitted by
    // joinScore. The fallback below remains available for older free-text orders.
    const canonical = value.match(/^(.*) (\d*) x (\d*) (.*)$/i);
    if (canonical)
        return { home: canonical[1], homeScore: canonical[2], awayScore: canonical[3], away: canonical[4] };
    const match = value.match(/^(.*?)\s+(\d+)\s*(?:[x×]|a)\s*(\d+)\s+(.*?)$/i) || value.match(/^(.*?)\s+(\d*)\s+[x×]\s+(\d*)\s+(.*?)$/i);
    return match ? { home: match[1], homeScore: match[2], awayScore: match[3], away: match[4] } : { home: '', homeScore: '', awayScore: '', away: '', unparsed: value };
}
function joinScore(value) { return `${value.home} ${value.homeScore} x ${value.awayScore} ${value.away}`; }
const SAO_PAULO_ZONE = 'America/Sao_Paulo';
const MONTHS = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const localCalendarDay = (date) => new Intl.DateTimeFormat('sv-SE', { timeZone: SAO_PAULO_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const calendarDate = (day, hour, minute) => {
    const date = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`);
    return Number.isFinite(date.getTime()) && localCalendarDay(date) === day ? date : null;
};
function naturalTime(text) {
    if (/\bmeio[- ]dia\b/.test(text))
        return { hour: 12, minute: 0 };
    if (/\bmeia[- ]noite\b/.test(text))
        return { hour: 0, minute: 0 };
    let found = text.match(/(?:^|\D)(\d{1,2})\s*(?::|h)\s*(\d{1,2})?(?:\D|$)/);
    if (!found)
        found = text.match(/\b(?:as|pelas?|por volta das?)\s+(\d{1,2})(?:\s*(?::|h|e)\s*(\d{1,2}))?\s*(?:horas?)?\b/);
    if (!found)
        found = text.match(/\b(\d{1,2})\s*horas?(?:\s*e\s*(\d{1,2}))?\b/);
    if (!found)
        return null;
    let hour = Number(found[1]);
    let minute = /\be meia\b/.test(text) ? 30 : Number(found[2] || 0);
    if (/\b(?:da|de) tarde\b|\b(?:da|de) noite\b/.test(text)) {
        if (hour < 12)
            hour += 12;
    }
    if (/\b(?:da|de) manha\b/.test(text) && hour === 12)
        hour = 0;
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}
function dayFromParts(dayNumber, monthNumber, yearNumber, hour, minute) {
    const day = `${yearNumber}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
    return calendarDate(day, hour, minute);
}
// Common spoken forms are resolved locally. The chat asks the AI to normalize rarer
// but understandable phrases before showing the review.
function resolveMatchDate(value, now = new Date()) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(value.trim())) {
        const input = value.trim();
        const calendar = new Date(`${input.slice(0, 10)}T12:00:00Z`);
        if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== input.slice(0, 10) || Number(input.slice(11, 13)) > 23 || Number(input.slice(14, 16)) > 59)
            return null;
        const date = new Date(/(Z|[+-]\d{2}:\d{2})$/.test(value.trim()) ? value.trim() : `${value.trim()}-03:00`);
        return Number.isFinite(date.getTime()) ? date : null;
    }
    const text = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const time = naturalTime(text);
    if (!time)
        return null;
    const h = time.hour, m = time.minute;
    const today = localCalendarDay(now);
    const currentYear = Number(today.slice(0, 4));
    const currentMonth = Number(today.slice(5, 7));
    const explicit = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
    const named = text.match(/\b(\d{1,2})\s+(?:de\s+)?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+(?:de\s+)?(\d{4}))?\b/);
    let day = today;
    if (explicit) {
        let year = Number(explicit[3] ? (explicit[3].length === 2 ? `20${explicit[3]}` : explicit[3]) : currentYear);
        let date = dayFromParts(Number(explicit[1]), Number(explicit[2]), year, h, m);
        if (!date)
            return null;
        if (!explicit[3] && date < now) {
            year++;
            date = dayFromParts(Number(explicit[1]), Number(explicit[2]), year, h, m);
            if (!date)
                return null;
        }
        return date;
    }
    else if (named) {
        let year = Number(named[3] || currentYear);
        let date = dayFromParts(Number(named[1]), MONTHS[named[2]], year, h, m);
        if (!date)
            return null;
        if (!named[3] && date < now) {
            year++;
            date = dayFromParts(Number(named[1]), MONTHS[named[2]], year, h, m);
            if (!date)
                return null;
        }
        return date;
    }
    else if (/\bdia\s+(\d{1,2})\b/.test(text)) {
        const number = Number(text.match(/\bdia\s+(\d{1,2})\b/)[1]);
        let month = currentMonth, year = currentYear;
        let date = dayFromParts(number, month, year, h, m);
        if (!date || date < now) {
            month++;
            if (month > 12) {
                month = 1;
                year++;
            }
            date = dayFromParts(number, month, year, h, m);
        }
        return date;
    }
    else {
        const week = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
        const weekday = week.findIndex(name => new RegExp(`\\b${name}\\b`).test(text));
        if (weekday < 0 && !/\b(hoje|amanha|depois de amanha)\b/.test(text))
            return null;
        const localNoon = new Date(`${today}T12:00:00-03:00`);
        let offset = /\bdepois de amanha\b/.test(text) ? 2 : /\bamanha\b/.test(text) ? 1 : weekday >= 0 ? (weekday - localNoon.getUTCDay() + 7) % 7 : 0;
        if (weekday >= 0 && offset === 0 && new Date(`${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`) < now)
            offset = 7;
        localNoon.setUTCDate(localNoon.getUTCDate() + offset);
        day = localNoon.toISOString().slice(0, 10);
    }
    return calendarDate(day, h, m);
}
function formatMatchDateInput(date) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: SAO_PAULO_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}h${parts.minute}`;
}
function matchDateForDraft(draft) {
    const reference = draft.stage === 'review' && draft.reviewedAt ? new Date(draft.reviewedAt) : new Date();
    return Number.isFinite(reference.getTime()) ? resolveMatchDate(draft.values.match_datetime || '', reference) : null;
}
