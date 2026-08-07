import 'dotenv/config';

/** Lee un entero positivo del entorno; cae al default si falta o no es válido. */
function posInt(raw: string | undefined, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Lee un booleano del entorno. Todo lo que no sea "false"/"0" cuenta como true. */
function bool(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined || raw === '') return fallback;
    return raw !== 'false' && raw !== '0';
}

const s3Endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';

export const config = {
    chromePath: process.env.CHROME_EXECUTABLE_PATH ?? '/usr/bin/chromium',

    apiUrl: process.env.CHATSUNTALK_API_URL ?? 'http://localhost:8000',
    // Ruta del endpoint del agente. Configurable porque cambió entre versiones
    // (v2: /chatsuntalk/whatsapp, v3: /v3/chatsuntalk/whatsapp).
    apiPath: process.env.CHATSUNTALK_API_PATH ?? '/v3/chatsuntalk/whatsapp',
    // Secreto compartido que el agente valida en el header `X-API-Key`. Si va vacío,
    // el header no se envía (útil contra un endpoint sin autenticación).
    apiKey: process.env.CHATSUNTALK_API_KEY ?? '',
    // Un turno del agente incluye la llamada al LLM (y ahora transcripción/visión),
    // así que el timeout es generoso a propósito.
    apiTimeoutMs: posInt(process.env.CHATSUNTALK_API_TIMEOUT_MS, 120_000),

    llmModel: process.env.LLM_MODEL ?? 'openai/gpt-oss-120b',

    // Almacenamiento de media. Es S3-compatible a propósito: en desarrollo apunta al
    // MinIO del docker-compose y en producción se apunta a Backblaze B2 (que expone
    // una API S3-compatible) cambiando SOLO estas variables, sin tocar el código.
    storage: {
        // Endpoint que usa el BRIDGE para subir (dentro de la red de docker).
        endpoint: s3Endpoint,
        // Endpoint con el que se FIRMA la URL prefirmada. La firma SigV4 incluye el
        // host, así que la URL tiene que generarse con el host que el AGENTE puede
        // resolver, que no siempre es el mismo desde el que sube el bridge:
        // bridge (en docker) sube a http://minio:9000, pero el agente corriendo en el
        // host descarga desde http://localhost:9000.
        publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? s3Endpoint,
        region: process.env.S3_REGION ?? 'us-east-1',
        bucket: process.env.S3_BUCKET ?? 'whatsapp-media',
        accessKey: process.env.S3_ACCESS_KEY ?? 'minioadmin',
        secretKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
        // MinIO requiere path-style (http://host/bucket/key). B2 también lo acepta.
        forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
        // Crear el bucket al arrancar si no existe. Déjalo en true con MinIO; ponlo en
        // false contra Backblaze B2, cuya API S3 no soporta CreateBucket (el bucket se
        // crea desde su consola). Un fallo aquí nunca es fatal, solo se loguea.
        ensureBucket: bool(process.env.S3_ENSURE_BUCKET, true),
        // Vida del enlace prefirmado que se le manda al agente. Solo tiene que durar
        // lo que tarda el agente en descargar el archivo.
        urlTtlSeconds: posInt(process.env.MEDIA_URL_TTL, 3600),
        // Tope de tamaño del archivo descargado de WhatsApp. Por encima se descarta el
        // media (el turno igual llega al agente, marcado como no procesable).
        maxBytes: posInt(process.env.MEDIA_MAX_BYTES, 20 * 1024 * 1024),
    },
};
