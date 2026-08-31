'use strict';

(function () {
  const cfg = window.PUB_GURU_CONFIG;
  if (!cfg || !window.supabase) throw new Error('PUB GURU backend configuration is missing.');

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const KEY = 'pub_guru_context_v1';
  const context = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  };
  const saveContext = value => localStorage.setItem(KEY, JSON.stringify(value));
  const clearContext = () => localStorage.removeItem(KEY);

  async function currentUser() {
    const { data, error } = await client.auth.getUser();
    if (error) return null;
    return data.user || null;
  }

  async function signUp(email, password) {
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async function signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    clearContext();
    if (error) throw error;
  }

  async function loadContext() {
    const user = await currentUser();
    if (!user) { clearContext(); return null; }

    const { data: memberships, error: membershipError } = await client
      .from('memberships')
      .select('organization_id,role')
      .eq('user_id', user.id)
      .limit(1);
    if (membershipError) throw membershipError;
    if (!memberships?.length) return { user, organization: null, venue: null, role: null };

    const membership = memberships[0];
    const { data: org, error: orgError } = await client
      .from('organizations')
      .select('id,name')
      .eq('id', membership.organization_id)
      .single();
    if (orgError) throw orgError;

    const { data: venues, error: venueError } = await client
      .from('venues')
      .select('id,name,timezone,currency')
      .eq('organization_id', org.id)
      .order('created_at', { ascending: true })
      .limit(1);
    if (venueError) throw venueError;

    const value = { user: { id: user.id, email: user.email }, organization: org, venue: venues?.[0] || null, role: membership.role };
    saveContext(value);
    return value;
  }

  async function createWorkspace(organizationName, venueName) {
    const user = await currentUser();
    if (!user) throw new Error('Nejdřív se přihlas.');

    const { data: org, error: orgError } = await client
      .from('organizations')
      .insert({ name: organizationName.trim(), created_by: user.id })
      .select('id,name')
      .single();
    if (orgError) throw orgError;

    const { error: membershipError } = await client
      .from('memberships')
      .insert({ organization_id: org.id, user_id: user.id, role: 'owner' });
    if (membershipError) throw membershipError;

    const { data: venue, error: venueError } = await client
      .from('venues')
      .insert({ organization_id: org.id, name: venueName.trim(), created_by: user.id })
      .select('id,name,timezone,currency')
      .single();
    if (venueError) throw venueError;

    const value = { user: { id: user.id, email: user.email }, organization: org, venue, role: 'owner' };
    saveContext(value);
    return value;
  }

  window.PubGuruBackend = Object.freeze({ client, context, currentUser, signUp, signIn, signOut, loadContext, createWorkspace, clearContext });

  const loadLayer = (src, dataKey) => {
    if (document.querySelector(`script[data-${dataKey}]`)) return;
    const script = document.createElement('script');
    script.src = src;
    script.defer = true;
    script.setAttribute(`data-${dataKey}`, '1');
    document.head.appendChild(script);
  };

  loadLayer('roles.js', 'pub-guru-roles');
  const page = location.pathname.split('/').pop();
  if (!page || page === 'index.html') {
    loadLayer('data-sync.js', 'pub-guru-data-sync');
    loadLayer('operations-backend.js', 'pub-guru-operations');
    loadLayer('invoice-ui-guard.js', 'pub-guru-invoice-ui-guard');
  }
})();
