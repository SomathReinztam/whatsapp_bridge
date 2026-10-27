/**
 * Subida de media de WhatsApp a un almacén S3-compatible (MinIO en desarrollo,
 * Backblaze B2 en producción).
 *
 * Por qué existe: el agente recibe un ENLACE al archivo, no los bytes. Ese es el
 * contrato que ya usa contra el backend real (un enlace de Backblaze que el agente
 * descarga con httpx antes de transcribir/analizar). Manteniendo el mismo contrato
 * aquí, migrar de MinIO a B2 es cambiar variables de entorno, no código.
 *
 * Se firman URLs temporales (presigned GET) en vez de exponer el bucket como público:
 * es lo mismo que hace B2 y evita dejar audios/fotos de usuarios accesibles a cualquiera.
 */

import {
    CreateBucketCommand,
    GetObjectCommand,
    HeadBucketCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { config } from './config';

const { storage } = config;

const credentials = {
    accessKeyId: storage.accessKey,
    secretAccessKey: storage.secretKey,
};

/** Cliente de subida: usa el endpoint interno (p. ej. http://minio:9000). */
const uploader = new S3Client({
    region: storage.region,
    endpoint: storage.endpoint,
    forcePathStyle: storage.forcePathStyle,
    credentials,
});

/**
 * Cliente usado SOLO para firmar la URL de descarga. La firma SigV4 incluye el host,
 * así que si el agente descarga desde un host distinto al de subida hay que firmar con
 * ese host o la firma no valida. Si ambos endpoints coinciden se reutiliza el uploader.
 */
const signer =
    storage.publicEndpoint === storage.endpoint
        ? uploader
        : new S3Client({
              region: storage.region,
              endpoint: storage.publicEndpoint,
              forcePathStyle: storage.forcePathStyle,
              credentials,
          });

/** Extensión por mimetype. Solo para que el archivo sea reconocible por su nombre. */
const EXTENSION_BY_MIME: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'application/pdf': 'pdf',
};

/** `audio/ogg; codecs=opus` -> `audio/ogg`. */
export function baseMimetype(mimetype: string): string {
    return (mimetype ?? '').split(';')[0].trim().toLowerCase();
}

function extensionFor(mimetype: string, filename?: string): string {
    const known = EXTENSION_BY_MIME[baseMimetype(mimetype)];
    if (known) return known;

    const fromName = filename?.split('.').pop();
    if (fromName && /^[A-Za-z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase();

    return 'bin';
}

/** Deja solo caracteres seguros para una key de S3. */
function sanitize(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Verifica el bucket y lo crea si no existe. Nunca lanza: contra Backblaze B2
 * `CreateBucket` no está soportado (el bucket se crea desde su consola), así que un
 * fallo aquí solo se avisa y el bridge sigue arrancando.
 */
export async function ensureBucket(): Promise<void> {
    if (!storage.ensureBucket) return;

    try {
        await uploader.send(new HeadBucketCommand({ Bucket: storage.bucket }));
        console.log(`🪣 Bucket "${storage.bucket}" disponible en ${storage.endpoint}`);
        return;
    } catch {
        // No existe (o no se pudo consultar): se intenta crear abajo.
    }

    try {
        await uploader.send(new CreateBucketCommand({ Bucket: storage.bucket }));
        console.log(`🪣 Bucket "${storage.bucket}" creado en ${storage.endpoint}`);
    } catch (err) {
        console.warn(
            `⚠️  No se pudo verificar/crear el bucket "${storage.bucket}": ${err}. ` +
                'Si el almacén ya lo tiene creado, ignora este aviso.',
        );
    }
}

export type UploadedMedia = {
    /** Enlace prefirmado y temporal que el agente usa para descargar el archivo. */
    url: string;
    /** Key dentro del bucket, útil para rastrear el archivo en los logs. */
    key: string;
    bytes: number;
};

export type UploadMediaInput = {
    /** Bytes del archivo ya decodificados. */
    data: Buffer;
    mimetype: string;
    /** Se usa para agrupar las keys por tipo (`audio/`, `image/`, ...). */
    kind: string;
    /** Teléfono del remitente; agrupa las keys por usuario. */
    phone: string;
    /** ID del mensaje de WhatsApp; hace la key única e idempotente por mensaje. */
    messageId: string;
    filename?: string;
};

/**
 * Sube el archivo y devuelve un enlace prefirmado de descarga.
 * Lanza si la subida o la firma fallan; el llamador decide el fallback.
 */
export async function uploadMedia(input: UploadMediaInput): Promise<UploadedMedia> {
    const ext = extensionFor(input.mimetype, input.filename);
    // La key incluye el ID del mensaje: reenviar el mismo mensaje sobrescribe el mismo
    // objeto en vez de acumular duplicados.
    const key = `${sanitize(input.kind)}/${sanitize(input.phone)}/${sanitize(input.messageId).slice(-48)}.${ext}`;

    await uploader.send(
        new PutObjectCommand({
            Bucket: storage.bucket,
            Key: key,
            Body: input.data,
            ContentType: baseMimetype(input.mimetype) || 'application/octet-stream',
        }),
    );

    const url = await getSignedUrl(
        signer,
        new GetObjectCommand({ Bucket: storage.bucket, Key: key }),
        { expiresIn: storage.urlTtlSeconds },
    );

    return { url, key, bytes: input.data.length };
}

/**
 * Baja un objeto del bucket por su key. El agente devuelve las keys de los archivos que
 * genera (no enlaces): bridge y agente comparten bucket, así que se lee directo.
 */
export async function downloadObject(
    key: string,
): Promise<{ data: Buffer; mimetype: string; filename: string }> {
    const cleanKey = key.trim().replace(/^\/+/, '');
    const res = await uploader.send(
        new GetObjectCommand({ Bucket: storage.bucket, Key: cleanKey }),
    );
    const data = Buffer.from(await res.Body!.transformToByteArray());
    return {
        data,
        mimetype: res.ContentType || 'application/octet-stream',
        filename: cleanKey.split('/').pop() || 'archivo',
    };
}
