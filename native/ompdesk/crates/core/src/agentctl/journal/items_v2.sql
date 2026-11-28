CREATE INDEX item_mail_session ON item_mail(session);
CREATE INDEX item_mail_wake ON item_mail(session) WHERE json_extract(mail_json,'$.kind')='question';
PRAGMA user_version = 2;
