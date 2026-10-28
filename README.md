# WhatsApp bridge de ChatSunTalk

Puente entre un número de WhatsApp (whatsapp-web.js, sesión por QR) y el agente
ChatSunTalk. Cada mensaje entrante (texto, audio, imagen, video, ubicación) se manda a
`POST {CHATSUNTALK_API_URL}{CHATSUNTALK_API_PATH}` (`/v4/chatsuntalk/whatsapp`) y la
respuesta del agente se envía de vuelta por WhatsApp. Más detalle del contrato de media en
`nota.txt`.

## Levantar (desarrollo)

```bash
cp .env.example .env        # revisa CHATSUNTALK_API_KEY y las variables S3_*
docker compose up --build -d
docker compose logs -f      # la primera vez aparece el QR
```

- El bridge **no levanta su propio MinIO**: reutiliza el que ya corre en el host
  (`SunTalk/minio`, puerto 9000). `S3_ENDPOINT` y `S3_PUBLIC_ENDPOINT` apuntan a
  `http://host.docker.internal:9000` y `S3_ACCESS_KEY`/`S3_SECRET_KEY` son las de ese MinIO.
  Para usar el MinIO del compose: `docker compose --profile local-minio up`.
- El agente (`ChatSunTalk`) debe usar el **mismo bucket y credenciales** (`MINIO_*` en su `.env`).
  El agente y el bridge intercambian `key`s del bucket, no bytes.
- La sesión de WhatsApp queda en el volumen `wa_auth`: reiniciar no pide QR de nuevo.

## Problemas conocidos (WhatsApp Web cambia y rompe whatsapp-web.js)

whatsapp-web.js 1.34.7 usa módulos internos de WhatsApp Web, que cambian sin aviso. Los tres
fallos de abajo son de ese tipo; los parches viven en `src/messagePayload.ts` y
`src/waPatches.ts`. Si aparece uno nuevo, lo útil es **ver el error real dentro de la página**
en vez de adivinar: las funciones `diagnose*` ya hacen eso y escriben una línea `🔎` en el log.

### 1. Descarga de media falla con `r: r` (julio 2026)

- **Síntoma:** `descarga de media falló ... r: r`, el agente recibe `media_error`.
- **Causa:** WhatsApp Web renombró `id._serialized` a `id.$1`; la librería lee `_serialized`,
  recibe `undefined` y falla. Bug upstream abierto
  (https://github.com/wwebjs/whatsapp-web.js/issues/201833).
- **Solución:** `backfillSerializedId()` en `messagePayload.ts` rellena `msg.id._serialized`
  antes de descargar.

### 2. Descarga de media falla con `t: t` (octubre 2026)

- **Síntoma:** `descarga de media falló tras 3 intentos (image): t: t`. Todas las imágenes,
  audios y videos entrantes llegan al agente como no procesables.
- **Causa:** el log `🔎 diagnóstico` mostró `InvalidMediaFileType: Unexpected mimetype
  application/octet-stream for media type image`. El `downloadManager` de WhatsApp Web ahora
  valida el tipo del archivo descifrado y la librería no le pasa `mimetype`.
- **Solución:** `downloadMediaPatched()` en `messagePayload.ts` repite el flujo de
  `msg.downloadMedia()` pasando `mimetype: msg.mimetype`. Si no entrega nada, cae a la
  descarga original.

### 3. Envío de imágenes/videos falla con "Data passed to getter must include an id property"

- **Síntoma:** el texto sale bien pero cualquier archivo que manda el agente falla con
  `no se pudo enviar el archivo: Error: Data passed to getter must include an id property
  (it's how we memoize) but got undefined`. Pasa con imágenes y videos, de cualquier tamaño.
- **Causa:** `WWebJS.sendMessage` arma el mensaje con `...mediaOptions`, donde `mediaOptions`
  es la instancia del modelo de media. Al esparcirla se cuelan propiedades internas
  (`parent`, `collection`, `__x_*`, `_uiObservers`, `mirror`, varias `undefined`) que el
  constructor de mensajes actual no tolera.
- **Solución:** `patchMediaSend()` en `waPatches.ts` envuelve `WWebJS.processMediaData` para que
  devuelva un objeto plano (`toJSON()` sin `undefined` + `clientUrl`, `uploadhash`,
  `streamingSidecar`, `preview`...). Se aplica en cada evento `ready` y el log muestra
  `🩹 parche de envío de media: aplicado`.
- **Hipótesis descartadas** (para no repetirlas): códecs de Chromium (también fallaba una
  imagen PNG pequeña), enviar como documento (`sendMediaAsDocument` falla igual) y que
  `toJSON()` trajera una clave `id` (no la trae).

### Cómo diagnosticar uno nuevo

1. `docker compose logs --tail 60 whatsapp-bridge | grep -E "🔎|❌"`
2. Descarga fallida: `diagnoseMediaFailure` (en `messagePayload.ts`) reproduce los pasos de
   `downloadMedia()` dentro de la página e informa `mediaStage` y el error real.
3. Envío fallido: `diagnoseSendFailure` (en `diagnostics.ts`) reproduce la preparación y la
   subida y arma el mensaje sin enviarlo; el campo `failedAt` o las claves `undefined` indican
   dónde se rompe.
4. Si el parche se vuelve inmanejable, probar una versión más nueva de whatsapp-web.js: cambia
   el SHA del tarball en `package.json` y corre `npm install` (ver `nota.txt`).

## Otros

- Un video sale como video; no hizo falta cambiar Chromium por Chrome.
- AWS SDK avisa que dejará de soportar Node 20 después de enero de 2027: subir la imagen base
  a Node 22 antes de esa fecha.
