import { Client, MessageMedia } from 'whatsapp-web.js';

/**
 * Diagnóstico de un envío de media fallido: repite dentro de WhatsApp Web los pasos de
 * `WWebJS.processMediaData` (la librería solo propaga "Data passed to getter must include
 * an id property") y devuelve en qué paso se rompe. Nunca lanza; es solo para el log.
 */
export async function diagnoseSendFailure(
    client: Client,
    media: MessageMedia,
    chatId: string,
): Promise<unknown> {
    try {
        return await (client as any).pupPage.evaluate(
            async (
                mediaInfo: { mimetype: string; data: string; filename?: string },
                chatIdArg: string,
            ) => {
                const g = globalThis as any;
                const info: Record<string, unknown> = {
                    mimetype: mediaInfo.mimetype,
                    base64Len: mediaInfo.data?.length,
                    wwebjsKeys: Object.keys(g.WWebJS ?? {}).filter((k) => /media|Media/.test(k)),
                };
                const describe = (e: any) => ({
                    name: e?.name,
                    message: e?.message,
                    stack: String(e?.stack ?? '').split('\n').slice(0, 5).map((l: string) => l.slice(0, 140)).join(' | '),
                });
                let step = 'mediaInfoToFile';
                try {
                    const file = g.WWebJS.mediaInfoToFile(mediaInfo);
                    info.fileType = file?.type;
                    info.fileSize = file?.size;

                    step = 'OpaqueData.createFromData';
                    const OpaqueData = g.require('WAWebMediaOpaqueData');
                    const opaque = await OpaqueData.createFromData(file, mediaInfo.mimetype);

                    step = 'prepRawMedia';
                    const prep = g.require('WAWebPrepRawMedia').prepRawMedia(opaque, {});
                    step = 'waitForPrep';
                    const data = await prep.waitForPrep();
                    info.prepType = data?.type;
                    info.prepKeys = Object.keys(data ?? {}).slice(0, 40);
                    info.filehash = data?.filehash;
                    info.hasToJSON = typeof data?.toJSON;

                    step = 'getOrCreateMediaObject';
                    const mediaObject = g
                        .require('WAWebMediaStorage')
                        .getOrCreateMediaObject(data.filehash);
                    info.mediaObjectKeys = Object.keys(mediaObject ?? {}).slice(0, 20);

                    step = 'msgToMediaType';
                    const mediaType = g.require('WAWebMmsMediaTypes').msgToMediaType({
                        type: data.type,
                        isGif: data.isGif,
                        isNewsletter: false,
                    });
                    info.mediaType = mediaType;

                    step = 'blob/consolidate';
                    if (!(data.mediaBlob instanceof OpaqueData)) {
                        data.mediaBlob = await OpaqueData.createFromData(
                            data.mediaBlob,
                            data.mediaBlob.type,
                        );
                    }
                    data.renderableUrl = data.mediaBlob.url();
                    mediaObject.consolidate(data.toJSON());
                    data.mediaBlob.autorelease();

                    step = 'shouldUseMediaCache';
                    const mmsTypes = g.require('WAWebMmsMediaTypes');
                    const useCache = g
                        .require('WAWebMediaDataUtils')
                        .shouldUseMediaCache(mmsTypes.castToV4(mediaObject.type));
                    info.useCache = useCache;
                    if (useCache && data.mediaBlob instanceof OpaqueData) {
                        g.require('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache.put(
                            mediaObject.filehash,
                            data.mediaBlob.formData(),
                        );
                    }

                    step = 'uploadMedia';
                    const up = g.require('WAWebMediaMmsV4Upload');
                    info.uploadExports = Object.keys(up ?? {});
                    const uploaded = await up.uploadMedia({
                        mimetype: data.mimetype,
                        mediaObject,
                        mediaType,
                    });
                    info.hasMediaEntry = !!uploaded?.mediaEntry;
                    info.uploadedKeys = Object.keys(uploaded ?? {});
                    step = 'processMediaData(parcheado)';
                    const processed = await g.WWebJS.processMediaData(
                        { mimetype: mediaInfo.mimetype, data: mediaInfo.data, filename: mediaInfo.filename },
                        {},
                    );
                    info.processedPatched = !!g.WWebJS.processMediaData.__plainPatched;
                    const json = processed.toJSON ? processed.toJSON() : {};
                    info.processedIsPlain = !processed.toJSON && !('__x_id' in processed);
                    info.toJSONKeys = Object.keys(json);
                    info.toJSONHasId = 'id' in json;
                    info.ownKeysWithId = Object.keys(processed).filter((k) => /(^|_)id$/i.test(k));
                    info.undefinedInJSON = Object.keys(json).filter((k) => json[k] === undefined);

                    step = 'build message';
                    const chat = await g.WWebJS.getChat(chatIdArg, { getAsModel: false });
                    info.chatFound = !!chat;
                    const MsgKey = g.require('WAWebMsgKey');
                    const newId = await MsgKey.newId();
                    const key = new MsgKey({
                        from: chat.id,
                        to: chat.id,
                        id: newId,
                        selfDir: 'out',
                    });
                    const message = {
                        id: key,
                        body: processed.preview,
                        type: 'chat',
                        ...processed,
                        ...json,
                    } as Record<string, unknown>;
                    info.messageIdAfterSpread = typeof message.id;
                    info.messageIdIsKey = message.id === key;
                    info.messageUndefinedKeys = Object.keys(message).filter(
                        (k) => message[k] === undefined,
                    );
                    step = 'done';
                } catch (e) {
                    info.failedAt = step;
                    info.error = describe(e);
                }
                return info;
            },
            { mimetype: media.mimetype, data: media.data, filename: media.filename ?? undefined },
            chatId,
        );
    } catch (e) {
        return { diagnosticFailed: String(e) };
    }
}
