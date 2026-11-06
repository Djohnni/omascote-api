// Atendimento runtime restored from the existing O Mascote application.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
exports.GET = GET;
const lab_storage_1 = require("../lib/lab-storage");
async function POST(request) {
    const session = (0, lab_storage_1.labSession)(request);
    try {
        (0, lab_storage_1.localRequest)(request);
        if (Number(request.headers.get('content-length')) > 9 * 1024 * 1024)
            throw new Error('Use imagens de até 8 MB.');
        const data = await request.formData();
        const file = data.get('file');
        const field = (typeof data.get('field') === 'string' ? data.get('field') : 'attachment').slice(0, 80);
        if (!(file instanceof File) || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024)
            throw new Error('Envie PNG, JPG ou WebP com até 8 MB.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const valid = file.type === 'image/png' ? bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 : file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
        if (!valid)
            throw new Error('O arquivo não corresponde a uma imagem válida.');
        const id = crypto.randomUUID();
        await (0, lab_storage_1.bucket)().put(`${session}/files/${id}`, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { name: file.name.slice(0, 180) } });
        return Response.json({ ok: true, file: { id, field, name: file.name.slice(0, 180), type: file.type, size: file.size, url: `/api/files?id=${id}` } }, { headers: (0, lab_storage_1.headers)(session) });
    }
    catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : 'Falha no envio.' }, { status: 400, headers: (0, lab_storage_1.headers)(session) });
    }
}
async function GET(request) {
    try {
        (0, lab_storage_1.localRequest)(request);
        const session = (0, lab_storage_1.labSession)(request);
        const id = new URL(request.url).searchParams.get('id') || '';
        if (!/^[a-f0-9-]{36}$/.test(id))
            return new Response('Arquivo não encontrado', { status: 404 });
        const file = await (0, lab_storage_1.bucket)().get(`${session}/files/${id}`);
        if (!file)
            return new Response('Arquivo não encontrado', { status: 404 });
        return new Response(file.body, { headers: { 'Content-Type': file.httpMetadata?.contentType || 'image/png', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    }
    catch {
        return new Response('Arquivo indisponível', { status: 503 });
    }
}
