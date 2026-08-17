import { Message as WaMessage } from 'whatsapp-web.js';

import { baseMimetype } from './storage';

/** Tipos de media que el agente sabe (o sabrá) interpretar. */
export type MediaKind = 'image' | 'audio' | 'video' | 'document';

/** Clase de mensaje entrante ya normalizada. */
export type MessageKind = 'text' | MediaKind | 'location';

export type ParsedMedia = {
    kind: MediaKind;
    /** Bytes ya decodificados desde el base64 que entrega whatsapp-web.js. */
    data: Buffer;
    mimetype: string;
    filename?: string;
};

export type ParsedMessage = {
    phone: string;
    contactName: string;
    waMessageId: string;
    waTimestamp?: number;
    /** Cuerpo del mensaje. En imágenes y videos es el caption (puede venir vacío). */
    text: string;
    kind: MessageKind;
    /** Presente solo cuando `kind` es un tipo de media y la descarga funcionó. */
    media?: ParsedMedia;
    /** Presente solo cuando `kind === 'location'`. */
    location?: { latitude: number; longitude: number };
    /** Motivo por el que hay media en el mensaje pero no se pudo obtener/usar. */
    mediaError?: string;
};

/**
 * Tipos de mensaje de WhatsApp que no son conversación: avisos de cifrado, cambios de
 * grupo, registros de llamada, mensajes eliminados. Reenviarlos al agente solo genera
 * turnos basura.
 */
const IGNORED_WA_TYPES = new Set([
    'e2e_notification',
    'notification_template',
    'gp2',
    'call_log',
    'revoked',
    'ciphertext',
]);

export function shouldIgnoreMessage(msg: WaMessage): boolean {
    if (msg.fromMe) return true;
    if (IGNORED_WA_TYPES.has(msg.type as string)) return true;

    const from = msg.from ?? '';
    if (from.endsWith('@g.us')) return true;
    if (from === 'status@broadcast') return true;
    if (from.endsWith('@newsletter')) return true;
    return false;
}

/** Deriva la clase de media a partir del mimetype real del archivo. */
function kindFromMimetype(mimetype: string): MediaKind {
    const base = baseMimetype(mimetype);
    if (base.startsWith('image/')) return 'image';
    if (base.startsWith('audio/')) return 'audio';
    if (base.startsWith('video/')) return 'video';
    return 'document';
}

/**
 * Clase de media según el tipo que declara WhatsApp. Solo se usa cuando la descarga
 * falló y no hay mimetype: así el agente sabe QUÉ no se pudo procesar ("no pude
 * escuchar tu nota de voz" en vez de un genérico "no pude abrir tu archivo").
 */
function kindFromWaType(waType: string): MediaKind {
    switch (waType) {
        case 'image':
        case 'sticker':
            return 'image';
        // 'ptt' es la nota de voz; 'audio' es un archivo de audio adjunto.
        case 'ptt':
        case 'audio':
            return 'audio';
        case 'video':
            return 'video';
        default:
            return 'document';
    }
}

const DOWNLOAD_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 800;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Un id de mensaje serializado se ve así: `false_573001112233@c.us_3EB0ABCD...`
// (fromMe_remoteJID_id). Lo usamos para reconocer, dentro del objeto `id` minificado,
// cuál de sus campos string es el serialized real, sin depender del nombre exacto (`$1`).
const SERIALIZED_ID_RE = /^(true|false)_.+@[a-z.]+_/i;

/**
 * Rellena `msg.id._serialized` cuando WhatsApp Web lo dejó `undefined`.
 *
 * La actualización de WhatsApp Web de julio 2026 renombró el getter interno
 * `id._serialized` -> `id.$1`. whatsapp-web.js 1.34.7 todavía lee `this.id._serialized`
 * dentro de `downloadMedia()` (y de `getChats()`, etc.), así que ahora recibe `undefined`,
 * hace `Msg.get(undefined)` en la página y revienta con el error opaco `r: r`. Es un bug
 * upstream ABIERTO (no hay versión que lo corrija; fijar la versión de WA Web no ayuda).
 * Como `msg` es el mismo objeto que `downloadMedia()` lee por dentro, mutar aquí
 * `msg.id._serialized` basta para que la descarga vuelva a resolver el mensaje.
 * Ref: https://github.com/wwebjs/whatsapp-web.js/issues/201833
 *
 * Devuelve el serialized resuelto (o `undefined` si no se pudo), para loguearlo.
 */
function backfillSerializedId(msg: WaMessage): string | undefined {
    const id = msg?.id as unknown as Record<string, unknown> | undefined;
    if (!id) return undefined;
    if (typeof id._serialized === 'string' && id._serialized) return id._serialized as string;

    // 1) El campo directo `$1` que documenta el issue.
    if (typeof id.$1 === 'string' && SERIALIZED_ID_RE.test(id.$1)) {
        id._serialized = id.$1;
        return id.$1 as string;
    }
    // 2) Robusto al nombre minificado: cualquier campo string con forma de id serializado.
    for (const value of Object.values(id)) {
        if (typeof value === 'string' && SERIALIZED_ID_RE.test(value)) {
            id._serialized = value;
            return value;
        }
    }
    // 3) Último recurso: reconstruirlo desde las partes (fromMe_remote_id).
    const remote = id.remote as any;
    const remoteJid =
        typeof remote === 'string' ? remote : remote?._serialized ?? remote?.$1;
    if (remoteJid && id.id) {
        const rebuilt = `${id.fromMe ? 'true' : 'false'}_${remoteJid}_${id.id}`;
        id._serialized = rebuilt;
        return rebuilt;
    }
    return undefined;
}

/**
 * whatsapp-web.js a veces devuelve `undefined` (o lanza) en `downloadMedia()` cuando el
 * media aún no terminó de sincronizar/descifrar en el navegador, justo tras el evento
 * `message`. Sin reintento, el archivo se pierde en silencio y el usuario recibe un
 * "no se pudo procesar". Un par de reintentos con espera corta lo resuelve casi siempre.
 * Devuelve el media descargado o lanza el ÚLTIMO error real (ya no silencioso).
 */
async function downloadMediaWithRetry(msg: WaMessage) {
    // Reasegura el serialized antes de cada intento (el objeto `id` es el mismo que lee
    // la librería por dentro); sin esto, el media falla con el opaco `r: r`.
    backfillSerializedId(msg);
    let lastErr: unknown = new Error('WhatsApp no entregó el contenido del archivo');
    for (let intento = 1; intento <= DOWNLOAD_RETRIES; intento++) {
        try {
            const media = await msg.downloadMedia();
            if (media?.data) return media;
        } catch (err) {
            lastErr = err;
        }
        if (intento < DOWNLOAD_RETRIES) await sleep(DOWNLOAD_RETRY_DELAY_MS);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function resolveContact(msg: WaMessage): Promise<{ phone: string; contactName: string }> {
    try {
        const contact = await msg.getContact();
        const phone = contact.id.user;
        return { phone, contactName: contact.pushname || contact.name || phone };
    } catch {
        const phone = msg.from.split('@')[0];
        console.warn(`⚠️  Contacto no resolvible para ${msg.from}, usando ID: ${phone}`);
        return { phone, contactName: phone };
    }
}

/**
 * Normaliza un mensaje de WhatsApp. Descarga el media (si lo hay) a memoria, pero NO
 * lo sube: la subida vive en `storage.ts` y la orquesta `index.ts`.
 *
 * Los fallos de media no lanzan: se devuelven en `mediaError` para que el turno igual
 * llegue al agente marcado como no procesable, en vez de perder el mensaje del usuario.
 */
export async function parseMessage(msg: WaMessage, maxBytes: number): Promise<ParsedMessage> {
    const { phone, contactName } = await resolveContact(msg);

    // WhatsApp Web (update 2026-07) dejó `id._serialized` en `undefined`; lo rellenamos
    // antes de usarlo como key de subida y ANTES de descargar el media (ver
    // `backfillSerializedId`). Si aún así no se resuelve, se avisa para diagnosticar.
    const serializedId = backfillSerializedId(msg);
    if (!serializedId) {
        console.warn(
            `⚠️  [${phone}] id de mensaje sin _serialized; id=${JSON.stringify(msg?.id)}`,
        );
    }

    const parsed: ParsedMessage = {
        phone,
        contactName,
        waMessageId: serializedId ?? msg.id?._serialized ?? '',
        text: msg.body ?? '',
        kind: 'text',
    };

    if (typeof msg.timestamp === 'number' && msg.timestamp > 0) {
        parsed.waTimestamp = msg.timestamp;
    }

    if (msg.type === 'location') {
        parsed.kind = 'location';
        const loc = (msg as any).location;
        const raw = (msg as any)._data;
        const latitude = Number(loc?.latitude ?? raw?.lat);
        const longitude = Number(loc?.longitude ?? raw?.lng);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            parsed.location = { latitude, longitude };
        }
        return parsed;
    }

    if (!msg.hasMedia) return parsed;

    let media;
    try {
        media = await downloadMediaWithRetry(msg);
    } catch (err) {
        parsed.kind = kindFromWaType(msg.type as string);
        parsed.mediaError = `no se pudo descargar el archivo de WhatsApp: ${err}`;
        console.error(
            `❌ [${phone}] descarga de media falló tras ${DOWNLOAD_RETRIES} intentos (${msg.type}): ${err}`,
        );
        return parsed;
    }

    const data = Buffer.from(media.data, 'base64');
    parsed.kind = kindFromMimetype(media.mimetype);

    if (data.length === 0) {
        parsed.mediaError = 'el archivo descargado está vacío';
        return parsed;
    }
    if (data.length > maxBytes) {
        parsed.mediaError = `el archivo pesa ${data.length} bytes y el límite es ${maxBytes}`;
        return parsed;
    }

    parsed.media = {
        kind: parsed.kind,
        data,
        mimetype: media.mimetype,
        filename: media.filename ?? undefined,
    };
    return parsed;
}
