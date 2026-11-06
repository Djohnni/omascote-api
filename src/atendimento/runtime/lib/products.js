// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIDEO_PRODUCT_IDS = exports.PRODUCT_IDS = exports.PRODUCTS = void 0;
exports.isVideoAvailableForProduct = isVideoAvailableForProduct;
exports.isPerPlayerProduct = isPerPlayerProduct;
exports.videoPriceForProduct = videoPriceForProduct;
exports.videoPriceLabelForProduct = videoPriceLabelForProduct;
exports.getProduct = getProduct;
exports.productCatalogForModel = productCatalogForModel;
exports.PRODUCTS = [
    {
        id: 'proximo_jogo',
        name: 'Próximo Jogo',
        shortName: 'Próximo jogo',
        priceLabel: 'R$ 7,00',
        price: 7,
        category: 'time',
        description: 'Divulgue a próxima partida com os dois times, data, horário e competição.',
        image: '/products/proximo_jogo.jpg',
        examples: ['/products/proximo_jogo.jpg'],
        details: ['Dois escudos', 'Data e horário', 'Competição e local'],
        planEligible: true,
    },
    {
        id: 'resultado',
        name: 'Resultado do Jogo',
        shortName: 'Resultado',
        priceLabel: 'R$ 8,00',
        price: 8,
        category: 'time',
        description: 'Publique o placar da partida com visual profissional para as redes sociais.',
        image: '/products/resultado.jpg',
        examples: ['/products/resultado.jpg'],
        details: ['Placar', 'Competição', 'Escudo principal'],
        planEligible: true,
    },
    {
        id: 'jogador_escudo',
        name: 'Jogador + Escudo',
        shortName: 'Jogador + Escudo',
        priceLabel: 'R$ 6,00 por jogador',
        price: 6,
        category: 'jogador',
        description: 'Transforme a foto do jogador em um card profissional com o escudo do clube.',
        image: '/products/jogador-escudo-amostra-1.webp',
        examples: [
            '/products/jogador-escudo-amostra-1.webp',
            '/products/jogador-escudo-amostra-2.webp',
            '/products/jogador-escudo-amostra-3.webp',
        ],
        details: ['Foto do jogador', 'Nome', 'Escudo do time'],
        planEligible: true,
    },
    {
        id: 'contratacao',
        name: 'Contratação ou Renovação',
        shortName: 'Contratação',
        priceLabel: 'R$ 7,80 por jogador',
        price: 7.8,
        category: 'jogador',
        description: 'Anuncie um reforço ou uma renovação com foto, nome, posição e escudo.',
        image: '/products/contratacao-modelo-02.webp',
        examples: ['/products/contratacao-modelo-02.webp'],
        details: ['Foto e nome', 'Posição', 'Contratado ou renovado'],
        planEligible: true,
        note: 'Camiseta personalizada: + R$ 2,00',
    },
    {
        id: 'escalacao',
        name: 'Escalação',
        shortName: 'Escalação',
        priceLabel: 'R$ 8,00',
        price: 8,
        category: 'time',
        description: 'Apresente titulares e reservas em uma arte pronta para o dia do jogo.',
        image: '/products/escalacao.jpg',
        examples: ['/products/escalacao.jpg'],
        details: ['Titulares', 'Reservas', 'Confronto'],
        planEligible: true,
    },
    {
        id: 'patrocinador',
        name: 'Patrocinadores',
        shortName: 'Patrocinadores',
        priceLabel: 'R$ 8,00',
        price: 8,
        category: 'time',
        description: 'Destaque as marcas que apoiam seu clube em uma publicação profissional.',
        image: '/products/patrocinador.jpg',
        examples: ['/products/patrocinador.jpg'],
        details: ['Escudo do time', 'Logos', 'Título da arte'],
        planEligible: true,
    },
    {
        id: 'escudo3d',
        name: 'Escudo 3D',
        shortName: 'Escudo 3D',
        priceLabel: 'R$ 4,00',
        price: 4,
        category: 'time',
        description: 'Transforme o escudo do clube em uma versão 3D para usar nas redes sociais.',
        image: '/products/escudo3d.jpg',
        examples: ['/products/escudo3d.jpg'],
        details: ['Envie um escudo', 'Visual 3D', 'Pronto para postar'],
        planEligible: true,
    },
    {
        id: 'mascote_uniforme',
        name: 'Mascote do Time',
        shortName: 'Mascote',
        priceLabel: 'R$ 18,00',
        price: 18,
        category: 'time',
        description: 'Crie o mascote oficial do clube com animal, escudo, uniforme e cenário.',
        image: '/products/mascote_uniforme.jpg',
        examples: ['/products/mascote_uniforme.jpg'],
        details: ['Animal escolhido', 'Escudo', 'Uniforme opcional'],
        planEligible: false,
    },
    {
        id: 'proximo_jogo_jogador', name: 'Próximo Jogo — Atleta', shortName: 'Próximo jogo do atleta',
        priceLabel: 'R$ 7,00', price: 7, category: 'jogador',
        description: 'Divulgue a próxima partida ou prova com foco no atleta.',
        image: '/products/proximo_jogo.jpg', examples: ['/products/proximo_jogo.jpg'],
        details: ['Foto do atleta', 'Data e competição', 'Identidade da equipe'], planEligible: true,
    },
    {
        id: 'resultado_jogo_jogador', name: 'Resultado — Atleta', shortName: 'Resultado do atleta',
        priceLabel: 'R$ 8,00', price: 8, category: 'jogador',
        description: 'Destaque o resultado da partida ou prova com a foto do atleta.',
        image: '/products/resultado.jpg', examples: ['/products/resultado.jpg'],
        details: ['Foto do atleta', 'Resultado', 'Competição'], planEligible: true,
    },
    {
        id: 'personalizada', name: 'Outra imagem esportiva', shortName: 'Outra imagem esportiva',
        priceLabel: 'Valor sob análise', price: 0, category: 'time',
        description: 'Um pedido esportivo personalizado, usando os estilos do O Mascote.',
        image: '/products/jogador-escudo-amostra-1.webp', examples: ['/products/jogador-escudo-amostra-1.webp'],
        details: ['Objetivo esportivo', 'Textos e referências', 'Resumo confirmado'], planEligible: false,
    },
];
exports.PRODUCT_IDS = exports.PRODUCTS.map((product) => product.id);
const VIDEO_IMAGE_ONLY_PRODUCT_IDS = new Set([
    'jogador_escudo',
    'contratacao',
    'proximo_jogo_jogador',
    'resultado_jogo_jogador',
]);
exports.VIDEO_PRODUCT_IDS = exports.PRODUCT_IDS.filter((id) => id !== 'personalizada' && !VIDEO_IMAGE_ONLY_PRODUCT_IDS.has(id));
function isVideoAvailableForProduct(id) {
    return !VIDEO_IMAGE_ONLY_PRODUCT_IDS.has(id) && exports.VIDEO_PRODUCT_IDS.includes(id);
}
function isPerPlayerProduct(id) {
    return id === 'jogador_escudo' || id === 'contratacao';
}
function videoPriceForProduct(id) {
    if (!isVideoAvailableForProduct(id))
        return 0;
    return id === 'mascote_uniforme' ? 28 : 14.9;
}
function videoPriceLabelForProduct(id) {
    const price = videoPriceForProduct(id);
    if (!price)
        return '';
    const value = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(price);
    return `${value}${isPerPlayerProduct(id) ? ' por jogador' : ''}`;
}
function getProduct(id) {
    return exports.PRODUCTS.find((product) => product.id === id) ?? null;
}
function productCatalogForModel() {
    return exports.PRODUCTS.map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        description: product.description,
        price: product.priceLabel,
        details: product.details,
        note: 'note' in product ? product.note : null,
    }));
}
