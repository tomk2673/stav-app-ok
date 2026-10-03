-- Preserve the currently deployed transaction, including receipt restoration.
-- A later replacement of pos_commit removed mergeOrders from both allowlists.
do $migration$
declare
  definition text := pg_get_functiondef('public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)'::regprocedure);
  old_commands text := '''deleteOrder'',''addLine''';
  old_audit text := '''receiptId'',receipt_uuid)';
begin
  if (length(definition)-length(replace(definition,old_commands,'')))/length(old_commands) <> 2
     or strpos(definition,old_audit)=0 then
    raise exception 'pos_commit changed: review command allowlists before applying recovery';
  end if;
  definition := replace(definition,old_commands,'''deleteOrder'',''mergeOrders'',''addLine''');
  definition := replace(definition,old_audit,
    old_audit || ' || case when p_type=''mergeOrders'' then jsonb_build_object(''merge'',p_result) else ''{}''::jsonb end');
  execute definition;
end;
$migration$;
notify pgrst, 'reload schema';
