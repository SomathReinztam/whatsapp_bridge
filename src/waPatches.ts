import { Client } from 'whatsapp-web.js';

/**
 * Parche de envío de media para WhatsApp Web recientes (whatsapp-web.js 1.34.7).
 *
 * `WWebJS.sendMessage` arma el mensaje con `{ ..., ...mediaOptions, ...mediaOptions.toJSON() }`
 * donde `mediaOptions` es la INSTANCIA del modelo de media. Al esparcirla se cuelan sus
 * propiedades internas (`parent`, `collection`, `__x_*`, `_uiObservers`, `mirror`, ...,
 * varias `undefined`), que el constructor del mensaje de WhatsApp Web actual no tolera:
 * el envío revienta con "Data passed to getter must include an id property ... but got
 * undefined". Solo afecta a la media (el texto no pasa por ahí).
 *
 * Se envuelve `processMediaData` para que devuelva un objeto PLANO con los datos de
 * `toJSON()` ya definidos más los campos de subida que `sendMessage` usa (`preview`,
 * `caption`/`isViewOnce` los asigna él después).
 *
 * Hay que reaplicarlo en cada `ready`: si la página se recarga, `WWebJS` se reinyecta.
 */
export async function patchMediaSend(client: Client): Promise<void> {
    try {
        const patched = await (client as any).pupPage.evaluate(() => {
            const w = globalThis as any;
            const wwebjs = w.WWebJS;
            if (!wwebjs?.processMediaData) return 'sin processMediaData';
            if (wwebjs.processMediaData.__plainPatched) return 'ya aplicado';

            const UPLOAD_FIELDS = [
                'clientUrl',
                'deprecatedMms3Url',
                'uploadhash',
                'streamingSidecar',
                'mediaHandle',
            ];
            const original = wwebjs.processMediaData;
            const wrapped = async (...args: unknown[]) => {
                const mediaData = await original(...args);
                if (!mediaData?.toJSON) return mediaData;

                const plain: Record<string, unknown> = {};
                const json = mediaData.toJSON();
                for (const key of Object.keys(json)) {
                    if (key !== 'id' && json[key] !== undefined) plain[key] = json[key];
                }
                for (const key of UPLOAD_FIELDS) {
                    if (mediaData[key] !== undefined && mediaData[key] !== null) {
                        plain[key] = mediaData[key];
                    }
                }
                if (mediaData.preview !== undefined) plain.preview = mediaData.preview;
                return plain;
            };
            wrapped.__plainPatched = true;
            wwebjs.processMediaData = wrapped;
            return 'aplicado';
        });
        console.log(`🩹 parche de envío de media: ${patched}`);
    } catch (err) {
        console.warn(`⚠️  no se pudo aplicar el parche de envío de media: ${err}`);
    }
}
