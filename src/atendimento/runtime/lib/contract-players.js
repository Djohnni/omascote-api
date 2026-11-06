// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contractPlayers = contractPlayers;
exports.contractLines = contractLines;
function contractPlayers(values) {
    return (values.players || '').split('\n').filter(line => line.trim()).map(line => {
        const [name = '', position = '', announcement = '', jersey = ''] = line.split('|').map(v => v.trim());
        return { name, position, announcement: ['Contratado', 'Renovado'].includes(announcement) ? announcement : values.announcement === 'Renovado' ? 'Renovado' : 'Contratado', jersey: ['Sim', 'Não'].includes(jersey) ? jersey : values.jersey_requested === 'Sim' ? 'Sim' : 'Não' };
    });
}
function contractLines(players) { return players.map(p => `${p.name} | ${p.position} | ${p.announcement} | ${p.jersey}`).join('\n'); }
