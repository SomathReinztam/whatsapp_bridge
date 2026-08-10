import { Client, LocalAuth, Message as WaMessage, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

import { config } from './config';
import { MediaKind, ParsedMessage, parseMessage, shouldIgnoreMessage } from './messagePayload';
import { ensureBucket, uploadMedia } from './storage';

/**
 * Cuerpo que se envía al endpoint del agente.
 *
 * El media viaja como ENLACE, no como bytes: es el mismo contrato que el agente ya
 * tiene contra el backend real (un enlace de Backblaze que descarga antes de
 * transcribir/analizar). El agente decide qué hacer según `media_type`.
 *
 * Cuando hubo media pero no se pudo subir, va `media_type` + `media_error` SIN
 * `media_url`: el turno llega igual y el agente puede avisarle al usuario en vez de
 * quedarse mudo.
 */
type AgentRequest = {
    phone: string;
    message: string;
    model: string;
    media_type?: MediaKind;
    media_url?: string;
    media_mimetype?: string;
    media_error?: string;
    // TRANSITORIO: la rama `feat/audio-delay` del agente todavía espera el campo
    // `voice_url` para las notas de voz. Se manda duplicado con `media_url` para poder
    // probar contra esa rama sin tocarla. Eliminar cuando el agente lea `media_url`.
    voice_url?: string;
};

type AgentResponse = {
    text?: string;
    suntalk_state?: string;
    summary?: string | null;
    tag?: string | null;
    // Enlaces prefirmados de las imágenes que generó el agente (tool `generate_image`).
    // El bridge las descarga (host resoluble desde aquí, p. ej. minio:9000) y las envía.
    image_urls?: string[];
};

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: config.chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
});

client.on('qr', (qr) => {
    console.log('📱 Escanea el QR con WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp conectado. Esperando mensajes...');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Autenticación fallida:', msg);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️  WhatsApp desconectado:', reason);
});

/**
 * Sube el media (si lo hay) y arma el cuerpo para el agente.
 * Un fallo de subida no interrumpe el turno: se reporta en `media_error`.
 */
async function buildAgentRequest(parsed: ParsedMessage): Promise<AgentRequest> {
    const request: AgentRequest = {
        phone: parsed.phone,
        message: parsed.text,
        model: config.llmModel,
    };

    if (parsed.kind === 'text') return request;

    request.media_type = parsed.kind as MediaKind;

    if (!parsed.media) {
        request.media_error = parsed.mediaError ?? 'no se pudo obtener el archivo';
        return request;
    }

    request.media_mimetype = parsed.media.mimetype;

    try {
        const uploaded = await uploadMedia({
            data: parsed.media.data,
            mimetype: parsed.media.mimetype,
            kind: parsed.media.kind,
            phone: parsed.phone,
            messageId: parsed.waMessageId,
            filename: parsed.media.filename,
        });
        request.media_url = uploaded.url;
        if (parsed.media.kind === 'audio') request.voice_url = uploaded.url;
        console.log(`☁️  Subido ${uploaded.key} (${uploaded.bytes} bytes)`);
    } catch (err) {
        request.media_error = `no se pudo subir el archivo al almacenamiento: ${err}`;
        console.error(`❌ Error subiendo media de ${parsed.phone}:`, err);
    }

    return request;
}

async function callAgent(request: AgentRequest): Promise<AgentResponse | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['X-API-Key'] = config.apiKey;

    const res = await fetch(`${config.apiUrl}${config.apiPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(config.apiTimeoutMs),
    });

    if (!res.ok) {
        const body = await res.text();
        console.error(`❌ API error ${res.status}: ${body}`);
        return null;
    }

    return (await res.json()) as AgentResponse;
}

client.on('message', async (msg: WaMessage) => {
    if (shouldIgnoreMessage(msg)) return;

    let parsed: ParsedMessage;
    try {
        parsed = await parseMessage(msg, config.storage.maxBytes);
    } catch (err) {
        console.error('❌ Error parseando mensaje:', err);
        return;
    }

    // La ubicación todavía no tiene tratamiento en el agente: se registra y se descarta
    // para no inventar un contrato que después haya que deshacer.
    if (parsed.kind === 'location') {
        console.log(`📍 [${parsed.phone}] ubicación recibida (aún no soportada, se ignora)`);
        return;
    }

    // Texto vacío sin media: nada que procesar.
    if (parsed.kind === 'text' && !parsed.text.trim()) return;

    const preview = parsed.text.trim() || '(sin texto)';
    console.log(`📨 [${parsed.phone}] (${parsed.kind}) ${preview.slice(0, 80)}`);

    try {
        const request = await buildAgentRequest(parsed);
        const data = await callAgent(request);
        if (!data) return;

        if (data.suntalk_state && data.suntalk_state !== 'bot') {
            console.log(`🔀 [${parsed.phone}] chat fuera del bot: ${data.suntalk_state}`);
        }

        if (data.text) {
            await client.sendMessage(msg.from, data.text);
            console.log(`📤 [${parsed.phone}] ${data.text.slice(0, 80)}...`);
        }

        // Imágenes generadas por el agente: se descargan del enlace prefirmado (MinIO/B2)
        // y se envían como media. Un fallo en una no corta el turno ni las demás.
        if (data.image_urls?.length) {
            for (const url of data.image_urls) {
                try {
                    const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
                    await client.sendMessage(msg.from, media);
                    console.log(`🖼️  [${parsed.phone}] imagen enviada`);
                } catch (err) {
                    console.error(`❌ [${parsed.phone}] no se pudo enviar la imagen:`, err);
                }
            }
        }
    } catch (err) {
        console.error('❌ Error llamando a ChatSunTalk API:', err);
    }
});

async function main() {
    await ensureBucket();
    await client.initialize();
}

main().catch((err) => {
    console.error('❌ Error iniciando el bridge:', err);
    process.exit(1);
});

const shutdown = async () => {
    console.log('⏹️  Apagando bridge...');
    try { await client.destroy(); } catch {}
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
