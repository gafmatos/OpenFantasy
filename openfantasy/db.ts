import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// acha o usuário pelo telefone, ou cria um novo
export async function getOrCreateUser(phone: string, name?: string) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ phone, name }, { onConflict: 'phone' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// salva uma pergunta e resposta
export async function saveQA(userId: string, question: string, answer: string, marketSlug?: string) {
  const { error } = await supabase
    .from('messages')
    .insert({ user_id: userId, question, answer, market_slug: marketSlug });
  if (error) throw error;
}

// pega as últimas mensagens da pessoa (memória do bot)
export async function getHistory(userId: string, limit = 10) {
  const { data, error } = await supabase
    .from('messages')
    .select('question, answer, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}