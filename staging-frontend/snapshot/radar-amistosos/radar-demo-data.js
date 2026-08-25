(function () {
  "use strict";

  window.RadarDemoData = {
    storageKey: "meu-clube-fc:radar-demo:v3",
    profile: {
      teamName: "Estrela do Norte FC",
      shortName: "Estrela do Norte",
      city: "Joinville",
      state: "SC",
      instagram: "@estreladonortefc",
      modality: "Futebol society",
      category: "Livre",
      level: "Intermediário",
      publicProfile: true,
      termsAccepted: true,
      crestInitials: "EN",
      summary: "Time de amigos criado em 2018, competitivo dentro de campo e parceiro fora dele."
    },
    draft: {
      teamName: "Estrela do Norte FC",
      instagram: "@estreladonortefc",
      city: "Joinville",
      state: "SC",
      modality: "Futebol society",
      category: "Livre",
      level: "Intermediário",
      summary: "Time de amigos criado em 2018, competitivo dentro de campo e parceiro fora dele.",
      confidence: 88
    },
    checklist: [
      { key: "publicProfile", label: "Perfil público do time", detail: "Visível para outros clubes", ready: true },
      { key: "city", label: "Cidade e estado", detail: "Joinville, SC", ready: true },
      { key: "instagram", label: "Instagram do time", detail: "Falta comprovar que você controla o perfil", ready: false },
      { key: "termsAccepted", label: "Termos do Radar", detail: "Aceitos nesta demonstração", ready: true }
    ],
    suggestedOpponents: [
      { name: "Vila Nova Society", initials: "VN", distance: "6 km", level: "Intermediário", conduct: "Boa conduta", verified: true },
      { name: "Atlético Zona Sul", initials: "AZ", distance: "13 km", level: "Intermediário", conduct: "Novo no Radar", verified: false },
      { name: "União do Norte FC", initials: "UN", distance: "21 km", level: "Competitivo", conduct: "Boa conduta", verified: true }
    ],
    nearbyTeams: [
      {
        publicId: "11111111-1111-4111-8111-111111111111",
        slug: "uniao-vila-nova",
        name: "União Vila Nova",
        initials: "UV",
        city: "Araquari",
        state: "SC",
        distanceKm: 12,
        modality: "Society",
        category: "Livre",
        level: "Intermediário",
        day: "Domingo",
        period: "Tarde",
        availability: "Domingo, 30 ago · 15h às 18h",
        venue: "Casa ou fora",
        compatibility: 94,
        reasons: ["mesma modalidade", "nível compatível", "disponível domingo", "aceita jogar fora"],
        verifiedMatches: 7,
        reputation: { score: 4.8, punctuality: 4.9, organization: 4.6, communication: 4.8, fairPlay: 4.7, playAgain: 86 }
      },
      {
        publicId: "22222222-2222-4222-8222-222222222222",
        slug: "guerreiros-do-bairro",
        name: "Guerreiros do Bairro",
        initials: "GB",
        city: "Joinville",
        state: "SC",
        distanceKm: 6,
        modality: "Society",
        category: "Livre",
        level: "Intermediário",
        day: "Sábado",
        period: "Noite",
        availability: "Sábado, 29 ago · 19h às 22h",
        venue: "Visitante",
        compatibility: 92,
        reasons: ["mesma modalidade", "nível compatível", "disponível sábado", "aceita jogar fora"],
        verifiedMatches: 5,
        reputation: { score: 4.7, punctuality: 4.6, organization: 4.7, communication: 4.7, fairPlay: 4.8, playAgain: 81 }
      },
      {
        publicId: "44444444-4444-4444-8444-444444444444",
        slug: "bola-na-rede-fc",
        name: "Bola na Rede FC",
        initials: "BR",
        city: "Joinville",
        state: "SC",
        distanceKm: null,
        modality: "Society",
        category: "Livre",
        level: "Intermediário",
        day: "Sexta",
        period: "Noite",
        availability: "Sexta, 28 ago · 20h às 22h",
        venue: "Casa ou fora",
        compatibility: 90,
        reasons: ["mesma cidade", "mesma modalidade", "nível compatível", "aceita jogar fora"],
        verifiedMatches: 0,
        reputation: null
      },
      {
        publicId: "33333333-3333-4333-8333-333333333333",
        slug: "atletico-rio-bonito",
        name: "Atlético Rio Bonito",
        initials: "AR",
        city: "Joinville",
        state: "SC",
        distanceKm: 18,
        modality: "Society",
        category: "Livre",
        level: "Recreativo",
        day: "Sábado",
        period: "Tarde",
        availability: "Sábado, 29 ago · 14h às 17h",
        venue: "Mandante",
        compatibility: 86,
        reasons: ["mesma modalidade", "nível próximo", "disponível sábado"],
        verifiedMatches: 4,
        reputation: { score: 4.5, punctuality: 4.4, organization: 4.5, communication: 4.5, fairPlay: 4.6, playAgain: 78 }
      },
      {
        slug: "juventude-pirabeiraba",
        name: "Juventude Pirabeiraba",
        initials: "JP",
        city: "Joinville",
        state: "SC",
        distanceKm: 23,
        modality: "Society",
        category: "Livre",
        level: "Intermediário",
        day: "Domingo",
        period: "Manhã",
        availability: "Domingo, 30 ago · 9h às 12h",
        venue: "Visitante",
        compatibility: 84,
        reasons: ["mesma modalidade", "nível compatível", "disponível domingo", "aceita jogar fora"],
        verifiedMatches: 1,
        reputation: null
      },
      {
        slug: "academia-da-bola",
        name: "Academia da Bola",
        initials: "AB",
        city: "São Francisco do Sul",
        state: "SC",
        distanceKm: 25,
        modality: "Society",
        category: "Veterano",
        level: "Competitivo",
        day: "Domingo",
        period: "Tarde",
        availability: "Domingo, 30 ago · 16h às 19h",
        venue: "Casa ou fora",
        compatibility: 78,
        reasons: ["disponível domingo", "aceita jogar fora"],
        verifiedMatches: 3,
        reputation: { score: 4.3, punctuality: 4.2, organization: 4.3, communication: 4.3, fairPlay: 4.4, playAgain: 74 }
      },
      {
        slug: "norte-futsal-clube",
        name: "Norte Futsal Clube",
        initials: "NF",
        city: "Joinville",
        state: "SC",
        distanceKm: 8,
        modality: "Futsal",
        category: "Livre",
        level: "Intermediário",
        day: "Quarta",
        period: "Noite",
        availability: "Quarta, 26 ago · 20h às 22h",
        venue: "Mandante",
        compatibility: 76,
        reasons: ["nível compatível", "perto do seu time"],
        verifiedMatches: 6,
        reputation: { score: 4.6, punctuality: 4.5, organization: 4.6, communication: 4.6, fairPlay: 4.7, playAgain: 80 }
      },
      {
        slug: "esporte-clube-aventureiro",
        name: "EC Aventureiro",
        initials: "EA",
        city: "Joinville",
        state: "SC",
        distanceKm: 11,
        modality: "Campo",
        category: "Veterano",
        level: "Recreativo",
        day: "Domingo",
        period: "Manhã",
        availability: "Domingo, 30 ago · 10h às 12h",
        venue: "Mandante",
        compatibility: 70,
        reasons: ["perto do seu time", "disponível domingo"],
        verifiedMatches: 2,
        reputation: null
      },
      {
        slug: "tricolor-da-ilha",
        name: "Tricolor da Ilha",
        initials: "TI",
        city: "São Francisco do Sul",
        state: "SC",
        distanceKm: 24,
        modality: "Society",
        category: "Veterano",
        level: "Intermediário",
        day: "Sábado",
        period: "Manhã",
        availability: "Sábado, 29 ago · 9h às 11h",
        venue: "Visitante",
        compatibility: 68,
        reasons: ["nível compatível", "aceita jogar fora"],
        verifiedMatches: 0,
        reputation: null
      },
      {
        slug: "familia-unida-society",
        name: "Família Unida Society",
        initials: "FU",
        city: "Araquari",
        state: "SC",
        distanceKm: 19,
        modality: "Society",
        category: "Livre",
        level: "Recreativo",
        day: "Quinta",
        period: "Noite",
        availability: "Quinta, 27 ago · 19h às 21h",
        venue: "Casa ou fora",
        compatibility: 66,
        reasons: ["mesma modalidade", "nível próximo", "aceita jogar fora"],
        verifiedMatches: 1,
        reputation: null
      }
    ],
    invitations: [
      {
        id: "demo-convite-recebido",
        direction: "incoming",
        state: "pending",
        version: 1,
        opponentSlug: "esporte-clube-aventureiro",
        opponentName: "EC Aventureiro",
        opponentInitials: "EA",
        distance: "9 km",
        proposal: {
          date: "05/09/2026", time: "16:00", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC",
          venue: "Visitante", message: "Horário reservado e arbitragem confirmada."
        },
        updatedLabel: "há 12 min"
      },
      {
        id: "demo-convite-enviado",
        direction: "outgoing",
        state: "pending",
        version: 1,
        opponentSlug: "uniao-vila-nova",
        opponentName: "União Vila Nova",
        opponentInitials: "UV",
        distance: "12 km",
        proposal: {
          date: "30/08/2026", time: "15:00", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC",
          venue: "Mandante", message: "Campo disponível domingo à tarde."
        },
        updatedLabel: "há 1 h"
      },
      {
        id: "demo-convite-expirado",
        direction: "incoming",
        state: "expired",
        version: 2,
        opponentSlug: "tricolor-da-ilha",
        opponentName: "Tricolor da Ilha",
        opponentInitials: "TI",
        distance: "24 km",
        proposal: {
          date: "23/08/2026", time: "09:00", duration: "2h",
          modality: "Society", category: "Veterano", city: "São Francisco do Sul, SC",
          venue: "Visitante", message: null
        },
        updatedLabel: "ontem"
      }
    ],
    notifications: [
      { id: "demo-aviso-1", type: "invite", title: "Novo convite", detail: "EC Aventureiro · 05/09, 16h", read: false, time: "12 min" },
      { id: "demo-aviso-2", type: "accepted", title: "Convite aceito", detail: "União Vila Nova", read: false, time: "1 h" },
      { id: "demo-aviso-3", type: "confirmation", title: "Jogo confirmado", detail: "Guerreiros do Bairro", read: true, time: "ontem" }
    ],
    matches: [
      {
        id: "demo-partida-confirmada",
        opponentPublicId: "11111111-1111-4111-8111-111111111111",
        state: "scheduled",
        version: 1,
        opponentName: "União Vila Nova",
        opponentInitials: "UV",
        proposal: {
          date: "30/08/2026", time: "15:00", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC", venue: "Mandante"
        },
        contact: { name: "Carlos, responsável", phone: "(47) 99999-0000" },
          confirmation: { mine: false, opponent: false },
          result: { state: "empty", mine: null, opponent: null, official: null },
        cancellation: null,
        updatedLabel: "domingo"
      },
      {
        id: "demo-partida-aguardando",
        opponentPublicId: "22222222-2222-4222-8222-222222222222",
        state: "awaiting_occurrence",
        version: 2,
        opponentName: "Guerreiros do Bairro",
        opponentInitials: "GB",
        proposal: {
          date: "22/08/2026", time: "19:30", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC", venue: "Visitante"
        },
        contact: { name: "Rafael, responsável", phone: "(47) 98888-1200" },
          confirmation: { mine: true, opponent: false },
          result: { state: "empty", mine: null, opponent: null, official: null },
        cancellation: null,
        updatedLabel: "aguardando rival"
      },
      {
        id: "demo-partida-realizada",
        opponentPublicId: "33333333-3333-4333-8333-333333333333",
        state: "played",
        version: 3,
        opponentName: "Atlético Rio Bonito",
        opponentInitials: "AR",
        proposal: {
          date: "15/08/2026", time: "16:00", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC", venue: "Mandante"
        },
        contact: { name: "Bruno, responsável", phone: "(47) 97777-4400" },
          confirmation: { mine: true, opponent: true },
          result: { state: "empty", mine: null, opponent: null, official: null },
          cancellation: null,
          updatedLabel: "realizada"
      },
      {
        id: "demo-placar-recebido",
        opponentPublicId: "11111111-1111-4111-8111-111111111111",
        state: "played",
        version: 4,
        opponentName: "União Vila Nova",
        opponentInitials: "UV",
        proposal: {
          date: "12/08/2026", time: "20:00", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC", venue: "Visitante"
        },
        contact: { name: "Carlos, responsável", phone: "(47) 99999-0000" },
        confirmation: { mine: true, opponent: true },
        result: {
          state: "waiting_other", mine: null,
          opponent: { mine: 3, opponent: 2, at: "há 18 min" }, official: null
        },
        cancellation: null,
        updatedLabel: "placar recebido"
      },
      {
        id: "demo-placar-divergente",
        opponentPublicId: "22222222-2222-4222-8222-222222222222",
        state: "played",
        version: 5,
        opponentName: "Guerreiros do Bairro",
        opponentInitials: "GB",
        proposal: {
          date: "08/08/2026", time: "19:30", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC", venue: "Mandante"
        },
        contact: { name: "Rafael, responsável", phone: "(47) 98888-1200" },
        confirmation: { mine: true, opponent: true },
        result: {
          state: "divergent",
          mine: { mine: 3, opponent: 2, at: "ontem" },
          opponent: { mine: 2, opponent: 2, at: "ontem" },
          official: null
        },
        cancellation: null,
        updatedLabel: "placares diferentes"
      },
      {
        id: "demo-resultado-confirmado",
        opponentPublicId: "44444444-4444-4444-8444-444444444444",
        state: "played",
        version: 5,
        opponentName: "Bola na Rede FC",
        opponentInitials: "BR",
        proposal: {
          date: "16/08/2026", time: "18:00", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC", venue: "Mandante"
        },
        contact: { name: "Lucas, responsável", phone: "(47) 95555-2020" },
        confirmation: { mine: true, opponent: true },
        result: {
          state: "verified",
          mine: { mine: 4, opponent: 2, at: "16/08" },
          opponent: null,
          official: { mine: 4, opponent: 2, at: "16/08" }
        },
        cancellation: null,
        updatedLabel: "resultado oficial"
      },
      {
        id: "demo-partida-cancelada",
        opponentPublicId: "55555555-5555-4555-8555-555555555555",
        state: "cancelled",
        version: 2,
        opponentName: "Tricolor da Ilha",
        opponentInitials: "TI",
        proposal: {
          date: "09/08/2026", time: "09:00", duration: "2h",
          modality: "Society", category: "Veterano", city: "São Francisco do Sul, SC", venue: "Visitante"
        },
        contact: { name: "Diego, responsável", phone: "(47) 96666-3100" },
          confirmation: { mine: false, opponent: false },
          result: { state: "empty", mine: null, opponent: null, official: null },
        cancellation: { reason: "Clima", byMe: false, at: "08/08/2026" },
        updatedLabel: "cancelada"
      },
      {
        id: "demo-historico-empate",
        opponentPublicId: "11111111-1111-4111-8111-111111111111",
        state: "played",
        version: 5,
        opponentName: "União Vila Nova",
        opponentInitials: "UV",
        proposal: {
          date: "19/07/2026", time: "16:00", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC", venue: "Visitante"
        },
        contact: { name: "Carlos, responsável", phone: "(47) 99999-0000" },
        confirmation: { mine: true, opponent: true },
        result: {
          state: "verified",
          mine: { mine: 2, opponent: 2, at: "19/07" },
          opponent: null,
          official: { mine: 2, opponent: 2, at: "19/07" }
        },
        cancellation: null,
        updatedLabel: "resultado oficial"
      },
      {
        id: "demo-historico-derrota",
        opponentPublicId: "11111111-1111-4111-8111-111111111111",
        state: "played",
        version: 5,
        opponentName: "União Vila Nova",
        opponentInitials: "UV",
        proposal: {
          date: "28/06/2026", time: "10:00", duration: "2h",
          modality: "Society", category: "Livre", city: "Joinville, SC", venue: "Mandante"
        },
        contact: { name: "Carlos, responsável", phone: "(47) 99999-0000" },
        confirmation: { mine: true, opponent: true },
        result: {
          state: "verified",
          mine: { mine: 1, opponent: 3, at: "28/06" },
          opponent: null,
          official: { mine: 1, opponent: 3, at: "28/06" }
        },
        cancellation: null,
        updatedLabel: "resultado oficial"
      }
    ],
    safetyCases: [
      {
        id: "caso-demo-1", type: "Denúncia", category: "Conduta perigosa",
        status: "Em análise", version: 1, teamName: "Atlético Rio Bonito",
        matchId: null, createdLabel: "hoje"
      },
      {
        id: "caso-demo-2", type: "Contestação", category: "Placar incorreto",
        status: "Recebida", version: 1, teamName: "Guerreiros do Bairro",
        matchId: "demo-placar-divergente", createdLabel: "ontem"
      }
    ],
    moderationCases: [
      {
        id: "moderacao-demo-1", type: "Denúncia de partida", category: "Conduta perigosa",
        status: "Aberto", version: 1, teamName: "Atlético Rio Bonito",
        createdLabel: "há 18 min", priority: "24 h"
      },
      {
        id: "moderacao-demo-2", type: "Contestação", category: "Placar incorreto",
        status: "Atribuído", version: 2, teamName: "Guerreiros do Bairro",
        createdLabel: "há 1 h", priority: "8 h"
      }
    ],
    availabilities: [
      {
        id: "demo-disponibilidade-1",
        title: "Society · Quinta à noite",
        status: "active",
        dateLabel: "Quinta, 27 de agosto",
        period: "19h às 22h",
        city: "Joinville, SC",
        radius: "Até 25 km",
        category: "Livre",
        level: "Intermediário",
        homeAway: "Mandante ou visitante",
        notes: "Campo sintético. Dividimos a arbitragem."
      }
    ]
  };
})();
