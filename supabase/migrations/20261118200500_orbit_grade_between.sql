-- Ara not: "1-2", "2-3" … (iki notun ortası, değeri x.5)
create or replace function orbit.grade_value(p text) returns numeric language sql immutable as $$
  select case
    when p ~ '^[1-6][+-]?$' then substr(p, 1, 1)::numeric + case right(p, 1) when '-' then 0.3 when '+' then -0.3 else 0 end
    when p ~ '^[1-5]-[2-6]$' and substr(p, 3, 1)::int = substr(p, 1, 1)::int + 1 then substr(p, 1, 1)::numeric + 0.5
  end
$$;
