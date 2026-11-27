-- An image for each webhook (e.g. a template with a picture in Chatflux):
-- the address of a hosted image goes in every POST as "imagem_url".
--   * Disparos: one per campaign.
--   * Lembretes de retorno, aniversário and falta: one per webhook, set by
--     the super admin in Ajustes → Integrações.
-- Empty means no image ("imagem_url": "").

alter table campaigns add column image_url text
    check (image_url is null or image_url ~ '^https?://\S+$');

insert into settings (key, value, superadmin_only) values
    ('reminder_image_url', 'null', true),
    ('birthday_image_url', 'null', true),
    ('no_show_image_url', 'null', true)
on conflict (key) do nothing;

-- The Disparos list reads this view; "c.*" was fixed when it was created,
-- so it is rebuilt to include the new column.
drop view campaign_progress;
create view campaign_progress with (security_invoker = true) as
select c.*,
       count(r.id) filter (where r.status <> 'removido') as total,
       count(r.id) filter (where r.status = 'pendente') as pendentes,
       count(r.id) filter (where r.status = 'enviado') as enviados,
       count(r.id) filter (where r.status = 'erro') as erros,
       max(r.sent_at) as ultimo_envio
from campaigns c
left join campaign_recipients r on r.campaign_id = c.id
group by c.id;
