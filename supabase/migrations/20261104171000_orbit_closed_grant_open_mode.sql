alter table orbit.children drop constraint if exists children_closed_grant_mode_check;
alter table orbit.children add constraint children_closed_grant_mode_check check (closed_grant_mode in ('clock', 'usage', 'within', 'open'));
