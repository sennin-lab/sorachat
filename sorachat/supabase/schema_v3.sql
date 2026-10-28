alter table public.sc_users add column if not exists contact text not null default '';
alter table public.sc_users add column if not exists profile_url text not null default '';
do $$
begin
  alter table public.sc_users add constraint sc_users_contact_length check (char_length(contact) <= 120);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.sc_users add constraint sc_users_profile_url_length check (char_length(profile_url) <= 200);
exception when duplicate_object then null;
end $$;
