# Webhooks de lembrete, aniversário, falta e campanhas

Todo dia às 9h (horário de Brasília) o sistema manda um `POST` com JSON para cada lembrete de
retorno vencido e para cada aniversariante do dia, nas URLs configuradas em
**Ajustes → Integrações** (visível só para o super admin). É ali que o fluxo (n8n, Chatflux…) decide o texto e envia
a mensagem. O webhook de **falta** (paciente que não chegou) sai ao longo do dia — veja a seção
[Falta](#falta-paciente-não-chegou).

- Uma chamada por lembrete/aniversariante/falta. Responder qualquer `2xx` marca como enviado.
- Resposta fora de `2xx` (ou mais de 10 s sem responder): tenta de novo mais tarde, até 5 vezes.
- Com `WEBHOOK_SIGNING_SECRET` definido na Vercel, cada chamada traz
  `x-clinica-assinatura: sha256=<HMAC-SHA256 do corpo>` para o receptor conferir.
- Não são enviados: pacientes marcados como "não receber mensagens", sem telefone, ou que já têm
  um agendamento futuro (agendado/confirmado) — esses esperam para ver se o paciente refaz o
  procedimento. Lembretes atrasados mais que a tolerância (padrão 30 dias) também não.

Todos os webhooks mandam **um nível só**, com texto ou número em cada campo (fácil de usar como
variável no Chatflux/n8n). Datas em dd/mm/aaaa; o que não existe vem como texto vazio. Todos trazem
`"teste": false` (o botão **Enviar teste**, ao lado de cada webhook em Ajustes → Integrações, manda o
mesmo JSON com um paciente fictício e `"teste": true`) e os campos do paciente:

| Campo | O que é |
|---|---|
| `nome`, `primeiro_nome` | nome do paciente |
| `telefone` | WhatsApp no formato 55 + DDD + número |
| `idade`, `data_nascimento` | idade e nascimento (dd/mm/aaaa) |
| `ultima_visita`, `dias_desde_ultima_visita` | último atendimento em que chegou, e há quantos dias |
| `ultima_visita_agenda`, `ultima_visita_procedimentos` | onde foi e o que fez nessa visita |
| `total_visitas` | quantos atendimentos já teve |
| `procedimentos_realizados` | o que já fez e quantas vezes, ex.: `Botox (2x), Limpeza de pele (1x)` |
| `retornos_pendentes` | os 3 retornos previstos mais próximos |
| `proximo_agendamento` | o próximo horário marcado (`dd/mm/aaaa às hh:mm · Agenda`) ou vazio |
| `resumo` | tudo isso em poucas frases, pronto para a IA |
| `paciente_id` | id do paciente no sistema |

## Lembrete de retorno

| Campo | O que é |
|---|---|
| `tipo` | `"lembrete_retorno"` |
| `procedimento`, `retorno_em_meses` | o procedimento do retorno e o prazo dele |
| `data_ultima_vez`, `dias_desde_ultima_vez` | quando fez esse procedimento pela última vez |
| `vezes_que_fez` | quantas vezes já fez esse procedimento na clínica |
| `data_retorno_prevista` | quando deveria voltar (última vez + prazo, ou a data ajustada à mão) |
| `criado_manualmente`, `observacao` | se a equipe criou o lembrete à mão, e a observação dele |
| `lembrete_id`, `tentativa` | id do lembrete; 1 na primeira vez, aumenta a cada reenvio |

```json
{
  "tipo": "lembrete_retorno",
  "teste": false,
  "lembrete_id": "…",
  "tentativa": 1,
  "procedimento": "Limpeza de pele",
  "retorno_em_meses": 2,
  "data_ultima_vez": "27/10/2026",
  "dias_desde_ultima_vez": 21,
  "vezes_que_fez": 3,
  "data_retorno_prevista": "27/12/2026",
  "observacao": "",
  "criado_manualmente": false,
  "nome": "Vanessa Pereira Fonseca",
  "primeiro_nome": "Vanessa",
  "telefone": "5531992783288",
  "idade": 48,
  "data_nascimento": "18/11/1977",
  "ultima_visita": "27/10/2026",
  "dias_desde_ultima_visita": 21,
  "ultima_visita_agenda": "Estética",
  "ultima_visita_procedimentos": "Limpeza de pele",
  "total_visitas": 10,
  "procedimentos_realizados": "Limpeza de pele (3x), Depilação a laser (2x), Botox (1x)",
  "retornos_pendentes": "Depilação a laser (previsto para 22/12/2026), Limpeza de pele (previsto para 27/12/2026)",
  "proximo_agendamento": "",
  "resumo": "Vanessa Pereira Fonseca, 48 anos. 10 visita(s); a última em 27/10/2026 (Estética: Limpeza de pele). Já fez: Limpeza de pele (3x), Depilação a laser …",
  "paciente_id": "…"
}
```

## Aniversário

No dia do aniversário. `idade` é a idade que o paciente completa; `mensagem_id` e `tentativa`
identificam o envio.

```json
{
  "tipo": "aniversario",
  "teste": false,
  "mensagem_id": "…",
  "tentativa": 1,
  "nome": "Vanessa Pereira Fonseca",
  "primeiro_nome": "Vanessa",
  "telefone": "5531992783288",
  "idade": 49,
  "data_nascimento": "18/11/1977",
  "ultima_visita": "27/10/2026",
  "dias_desde_ultima_visita": 21,
  "ultima_visita_agenda": "Estética",
  "ultima_visita_procedimentos": "Limpeza de pele",
  "total_visitas": 10,
  "procedimentos_realizados": "Limpeza de pele (3x), Depilação a laser (2x), Botox (1x)",
  "retornos_pendentes": "Depilação a laser (previsto para 22/12/2026), Limpeza de pele (previsto para 27/12/2026)",
  "proximo_agendamento": "",
  "resumo": "Vanessa Pereira Fonseca, 48 anos. 10 visita(s); a última em 27/10/2026 (Estética: Limpeza de pele). Já fez: Limpeza de pele (3x), Depilação a laser …",
  "paciente_id": "…"
}
```

## Falta (paciente não chegou)

Quando um agendamento já passou do horário há mais de **2 horas** (ajustável em
**Ajustes → Integrações → Avisar a falta depois de**) e o paciente **não foi marcado como
"Chegou"**, o sistema manda um `POST` para o **Webhook de falta**. Uma vez por agendamento.

Como sai: o banco (Supabase, `pg_cron`) confere a cada 10 minutos e, só quando há alguma falta
para avisar, chama `/api/cron/faltas` do sistema, que monta e envia o JSON. Na prática o aviso sai
entre 2h e 2h10 depois do horário. Se essa checagem do banco estiver desligada, o envio diário
das 9h manda as faltas das últimas 24 horas.

**Conta como falta** o agendamento que continua *Agendado* ou *Confirmado*, ou que foi marcado
como *A remarcar* (`pediu_remarcar` / `nao_compareceu`).

**Não conta** (nada é enviado):
- paciente marcado como *Chegou*;
- agendamento cancelado pela API (`cancelado` — o paciente já avisou) ou removido da agenda;
- paciente que já tem outro agendamento depois desse (já remarcou, ou foi atendido em outra
  agenda mais tarde no mesmo dia);
- agendamento lançado depois do horário (registro retroativo ou importado);
- paciente marcado como "não receber mensagens" ou sem telefone;
- horário de mais de 24 horas atrás (aviso de falta de dias atrás não faz sentido; ligar o
  webhook também não dispara para o histórico).

Se o paciente for marcado como *Chegou* (ou remarcar) antes do envio, o aviso é descartado.
Falhas: nova tentativa em 10, 20, 40 e 80 minutos (5 no total) — a mesma regra de `2xx`,
10 s e assinatura `x-clinica-assinatura` dos outros webhooks.

| Campo | O que é |
|---|---|
| `tipo` | `"falta"` |
| `agendamento_data`, `agendamento_horario` | o horário perdido |
| `agendamento_agenda`, `agendamento_tipo`, `agendamento_procedimentos` | onde, o quê |
| `agendamento_status` | a situação, por extenso (ex.: "Confirmado pelo paciente") |
| `minutos_desde_o_horario` | quanto tempo já passou do horário marcado |
| `alerta_id`, `tentativa`, `agendamento_id` | ids do aviso e do agendamento; 1 na primeira vez |

```json
{
  "tipo": "falta",
  "teste": false,
  "alerta_id": "…",
  "tentativa": 1,
  "agendamento_data": "17/11/2026",
  "agendamento_horario": "14:00",
  "agendamento_agenda": "Estética",
  "agendamento_tipo": "Consulta",
  "agendamento_procedimentos": "Limpeza de pele",
  "agendamento_status": "Confirmado pelo paciente",
  "minutos_desde_o_horario": 124,
  "nome": "Vanessa Pereira Fonseca",
  "primeiro_nome": "Vanessa",
  "telefone": "5531992783288",
  "idade": 48,
  "data_nascimento": "18/11/1977",
  "ultima_visita": "27/10/2026",
  "dias_desde_ultima_visita": 21,
  "ultima_visita_agenda": "Estética",
  "ultima_visita_procedimentos": "Limpeza de pele",
  "total_visitas": 10,
  "procedimentos_realizados": "Limpeza de pele (3x), Depilação a laser (2x), Botox (1x)",
  "retornos_pendentes": "Depilação a laser (previsto para 22/12/2026), Limpeza de pele (previsto para 27/12/2026)",
  "proximo_agendamento": "",
  "resumo": "Vanessa Pereira Fonseca, 48 anos. 10 visita(s); a última em 27/10/2026 (Estética: Limpeza de pele). Já fez: Limpeza de pele (3x), Depilação a laser …",
  "paciente_id": "…",
  "agendamento_id": "…"
}
```

Para remarcar a partir daqui, o fluxo usa a API normal: `agenda/disponibilidade` e
`agenda/remarcar` com o `agendamento_id` recebido (ou `agenda/agendar` para um novo).

## Campanhas (Disparos)

Tela **Disparos** (só o super admin). Cada campanha tem **o seu webhook**: o sistema manda um `POST`
por paciente para a URL daquela campanha, no ritmo escolhido. O fluxo (n8n, Chatflux…) escreve e envia
a mensagem.

- **Quem recebe:** a base filtrada (agenda em que foi atendido, procedimento feito, última visita,
  aniversário no mês, idade, "sem nada marcado", busca por nome), menos os que você tirar, mais os que
  incluir à mão; ou só os pacientes escolhidos. Quem pediu para não receber mensagens ou não tem
  telefone **nunca** entra.
- **Cadência:** "enviar N mensagens a cada X minutos", com um intervalo sorteado entre A e B segundos
  entre uma e outra, só entre tal e tal hora, nos dias marcados (horário de Brasília). Ex.: 20 a cada 60
  minutos, 30–60 s entre elas, das 9h às 19h, de segunda a sábado.
- Iniciar, pausar, retomar e cancelar a qualquer momento. "Ver envios" mostra quem já recebeu, quem está
  na fila e os erros; dá para tirar alguém da fila.
- **Testar antes:** "Enviar teste" (na campanha ou no cartão dela) manda o mesmo JSON com um paciente
  fictício e `"teste": true`; com o seu telefone no campo opcional, a mensagem chega para você. A tela
  mostra o que o webhook respondeu e em quanto tempo.
- **Resposta:** o webhook tem 30 s para responder. Resposta fora de `2xx` ou endereço fora do ar: tenta
  de novo 5 minutos depois, até 3 vezes. Sem resposta em 30 s (o Chatflux, por exemplo, só responde
  depois de rodar as ações): conta como **enviado sem confirmação** e **nunca é reenviado**, para o
  paciente não receber duas vezes.
- Quem dispara é o próprio banco (Supabase, `pg_cron`), que confere a cada 10 segundos se há mensagem
  na hora e chama `/api/cron/campanhas`.

Um nível só, com texto ou número em cada campo (fácil de usar como variável no Chatflux/n8n). Datas em
dd/mm/aaaa; o que não existe vem como texto vazio.

```json
{
  "tipo": "campanha",
  "teste": false,
  "campanha": "Black Friday",
  "mensagem": "Botox com 20% até 30/11",
  "envio_id": "…",
  "tentativa": 1,
  "nome": "Vanessa Pereira Fonseca",
  "primeiro_nome": "Vanessa",
  "telefone": "5531992783288",
  "idade": 48,
  "ultima_visita": "27/10/2026",
  "dias_desde_ultima_visita": 20,
  "ultima_visita_agenda": "Estética",
  "ultima_visita_procedimentos": "Limpeza de pele",
  "total_visitas": 10,
  "procedimentos_realizados": "Limpeza de pele (3x), Depilação a laser (2x), Botox (1x)",
  "retornos_pendentes": "Depilação a laser (previsto para 22/12/2026)",
  "proximo_agendamento": "",
  "resumo": "Vanessa Pereira Fonseca, 48 anos. 10 visita(s); a última em 27/10/2026 (Estética: Limpeza de pele). Já fez: … Nada agendado.",
  "paciente_id": "…",
  "campanha_id": "…"
}
```

`telefone` já vem no formato do WhatsApp (55 + DDD + número). `retornos_pendentes` traz os 3 mais
próximos. `mensagem` é o texto livre da campanha (oferta, instrução para a IA). Com `WEBHOOK_SIGNING_SECRET`
definido, também vem `x-clinica-assinatura`.
