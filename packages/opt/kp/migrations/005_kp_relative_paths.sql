-- RFD-AI-AGENT-OPT-KP-DOWNLOAD, дефект 2а: пути файлов КП хранятся относительно KP_FILES_ROOT («kp/<аккаунт>/…»),
-- абсолютный путь собирается при чтении. Старые абсолютные пути («/opt-data/kp/…», «/data/kp/…») переводятся
-- в относительные от «kp/»; абсолютные пути без «/kp/» (свой каталог сертификатов) остаются как есть.
UPDATE kp_settings SET template_path = regexp_replace(template_path, '^.*/kp/', 'kp/')
 WHERE template_path LIKE '/%' AND template_path LIKE '%/kp/%';
UPDATE kp_settings SET certs_dir = regexp_replace(certs_dir, '^.*/kp/', 'kp/')
 WHERE certs_dir LIKE '/%' AND certs_dir LIKE '%/kp/%';
UPDATE kp_drafts SET docx_path = regexp_replace(docx_path, '^.*/kp/', 'kp/')
 WHERE docx_path LIKE '/%' AND docx_path LIKE '%/kp/%';
UPDATE kp_drafts SET pdf_path = regexp_replace(pdf_path, '^.*/kp/', 'kp/')
 WHERE pdf_path LIKE '/%' AND pdf_path LIKE '%/kp/%';
