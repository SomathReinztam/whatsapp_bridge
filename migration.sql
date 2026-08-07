-- Tabla de mapping entre números de WhatsApp y los IDs internos de ChatSunTalk.
-- Ejecutar una sola vez contra la base de datos del proyecto.

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
    phone       VARCHAR PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    chat_id     INTEGER NOT NULL REFERENCES chats(id),
    created_at  TIMESTAMP DEFAULT NOW()
);
