-- InPost moved its app login to OAuth (account.inpost-group.com), so users are keyed by
-- their InPost account id instead of a phone number, and SMS throttling is no longer needed.

drop table public.sms_requests;

delete from public.inpost_credentials;
alter table public.inpost_credentials rename column phone_hash to account_hash;
alter table public.inpost_credentials rename column auth_token to access_token;
