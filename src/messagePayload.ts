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

    const parsed: ParsedMessage = {
        phone,
        contactName,
        waMessageId: msg.id._serialized,
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
        media = await msg.downloadMedia();
    } catch (err) {
        parsed.kind = kindFromWaType(msg.type as string);
        parsed.mediaError = `no se pudo descargar el archivo de WhatsApp: ${err}`;
        return parsed;
    }

    if (!media?.data) {
        parsed.kind = kindFromWaType(msg.type as string);
        parsed.mediaError = 'WhatsApp no entregó el contenido del archivo';
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
