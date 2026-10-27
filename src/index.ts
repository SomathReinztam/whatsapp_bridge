import { Client, LocalAuth, Message as WaMessage, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

import { config } from './config';
import { MediaKind, ParsedMessage, parseMessage, shouldIgnoreMessage } from './messagePayload';
import { downloadObject, ensureBucket, uploadMedia } from './storage';

/**
 * Un adjunto del turno, ya subido a MinIO/B2.
 *
 * El media viaja como ENLACE, no como bytes: es el mismo contrato que el agente ya
 * tiene contra el backend real (un enlace que descarga antes de transcribir/analizar).
 * El agente decide qué hacer según `type`.
 *
 * Cuando hubo media pero no se pudo subir, va `type` + `error` SIN `url`: el turno llega
 * igual y el agente puede avisarle al usuario en vez de quedarse mudo.
 */
type MediaItem = {
    type: MediaKind;
    /** Key en el bucket compartido: la vía preferida del agente. */
    key?: string;
    url?: string;
    mimetype?: string;
    error?: string;
};

/**
 * Cuerpo que se envía al endpoint del agente. `media` es la LISTA de adjuntos del turno
 * (hoy 0 o 1: WhatsApp entrega un adjunto por mensaje).
 */
type AgentRequest = {
    phone: string;
    message: string;
    model: string;
    media: MediaItem[];
};

type AgentResponse = {
    text?: string;
    suntalk_state?: string;
    // Keys del bucket compartido (o enlaces) de los archivos que generó el agente (hoy imágenes de la tool
    // `generate_image`; a futuro PDFs/planillas). El bridge los descarga (host resoluble
    // desde aquí, p. ej. minio:9000) y los envía al usuario.
    media?: string[];
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
        media: [],
    };

    if (parsed.kind === 'text') return request;

    const item: MediaItem = { type: parsed.kind as MediaKind };
    request.media.push(item);

    if (!parsed.media) {
        item.error = parsed.mediaError ?? 'no se pudo obtener el archivo';
        // Antes esta rama era silenciosa: el media se perdía sin dejar rastro en el log y
        // el agente solo veía "no se pudo procesar". Se registra el motivo real.
        console.error(
            `⚠️  [${parsed.phone}] sin media utilizable (${item.type}): ${item.error}`,
        );
        return request;
    }

    item.mimetype = parsed.media.mimetype;

    try {
        const uploaded = await uploadMedia({
            data: parsed.media.data,
            mimetype: parsed.media.mimetype,
            kind: parsed.media.kind,
            phone: parsed.phone,
            messageId: parsed.waMessageId,
            filename: parsed.media.filename,
        });
        item.key = uploaded.key;
        item.url = uploaded.url;
        console.log(`☁️  Subido ${uploaded.key} (${uploaded.bytes} bytes)`);
    } catch (err) {
        item.error = `no se pudo subir el archivo al almacenamiento: ${err}`;
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

    // La ubicación llega como tarjeta nativa de WhatsApp. El agente no tiene un contrato
    // propio de ubicación, pero SÍ sabe leer un enlace de Google Maps como texto (es el
    // mismo paso del flujo de postulación). En vez de descartarla, la convertimos a un
    // enlace de Maps y la mandamos como un turno de texto normal.
    if (parsed.kind === 'location') {
        if (!parsed.location) {
            console.warn(`📍 [${parsed.phone}] ubicación sin coordenadas, se ignora`);
            return;
        }
        const { latitude, longitude } = parsed.location;
        const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        const caption = parsed.text.trim();
        parsed.kind = 'text';
        parsed.text = caption
            ? `${caption}\nUbicación compartida: ${mapsUrl}`
            : `Ubicación compartida: ${mapsUrl}`;
        console.log(`📍 [${parsed.phone}] ubicación -> ${mapsUrl}`);
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

        // Archivos generados por el agente (hoy imágenes; a futuro PDFs/planillas): se
        // descargan del enlace prefirmado (MinIO/B2) y se envían como media. Un fallo en
        // uno no corta el turno ni los demás.
        if (data.media?.length) {
            for (const url of data.media) {
                try {
                    // El agente devuelve KEYS del bucket compartido; por compatibilidad
                    // también se acepta un enlace http(s).
                    const media = /^https?:\/\//i.test(url)
                        ? await MessageMedia.fromUrl(url, { unsafeMime: true })
                        : await downloadObject(url).then(
                              (o) =>
                                  new MessageMedia(
                                      o.mimetype,
                                      o.data.toString('base64'),
                                      o.filename,
                                  ),
                          );
                    await client.sendMessage(msg.from, media);
                    console.log(`🖼️  [${parsed.phone}] archivo enviado`);
                } catch (err) {
                    console.error(`❌ [${parsed.phone}] no se pudo enviar el archivo:`, err);
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
