// Each team group has a color: its own, or its agenda's (Dr. Everson azul-aço,
// Simone âmbar, Estética verde-folha, Depilação rosa-forte); Recepção is
// vermelho-suave. Unread bubbles use it so everyone sees whose message it is.
export const CHANNEL_SELECT = '*, agenda:agendas(color)';

export const DEFAULT_CHANNEL_COLOR = '#7FA8D6';

export const channelColor = (channel) => channel?.color || channel?.agenda?.color || DEFAULT_CHANNEL_COLOR;

// The clinic's palette (04/11), offered when creating a group.
export const PALETTE = [
  ['Azul-aço', '#6F8FB8'], ['Âmbar', '#E8B86D'], ['Verde-folha', '#8CBF9A'], ['Rosa-forte', '#E58FA9'],
  ['Vermelho-suave', '#E07A7A'], ['Petróleo', '#5E9AA8'], ['Ametista', '#9B86C9'], ['Terracota', '#D98F76'],
  ['Roxo-uva', '#7A68B0'], ['Azul-real', '#7FA8D6'],
];
