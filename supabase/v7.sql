-- =====================================================================
--  La Classe : mise à jour v7
--  (dossiers envoyés en .zip, plus de types de fichiers, messages vocaux)
--  À exécuter APRÈS schema.sql, v3.sql, v4.sql, v5.sql et v6.sql, une seule fois.
-- =====================================================================

-- Nouveaux types de fichiers : documents (md, json, rtf), archives (7z, rar), audio (mp3, m4a, wav, ogg, weba), vidéo (mp4, webm).
-- « weba » = enregistrement vocal fait dans le navigateur (audio/webm).
alter table public.messages drop constraint messages_file_path_check;
alter table public.messages
  add constraint messages_file_path_check
  check (file_path is null or file_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|txt|csv|zip|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|md|json|rtf|7z|rar|mp3|m4a|wav|ogg|weba|mp4|webm)$');

update storage.buckets
set allowed_mime_types = array[
  'application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json', 'application/rtf', 'text/rtf',
  'application/zip', 'application/x-zip-compressed', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm',
  'video/mp4', 'video/webm'
]
where id = 'files';
