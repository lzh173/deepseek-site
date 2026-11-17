-- 「官方」渠道：kind 仍是 openai（走 OpenAI 兼容协议），
-- 用 official 标记区分，避免重建 channels 表去改 CHECK 约束。
ALTER TABLE channels ADD COLUMN official INTEGER NOT NULL DEFAULT 0;
