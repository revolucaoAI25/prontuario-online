# API de agendamento — Clínica Dr. Everson Rezeck

Todas as chamadas são `POST` com corpo JSON e o cabeçalho `x-api-key: <CLINIC_API_KEY>`
(ou `Authorization: Bearer <CLINIC_API_KEY>`).

Base: `https://<seu-dominio>/api`

- Datas: `AAAA-MM-DD` ou `DD/MM/AAAA`. Horários: `HH:MM` (também aceita `9h`, `9h30`).
- Tudo no horário de Brasília.
- `agenda` aceita o id ou parte do nome, sem acento: `"everson"`, `"simone"`, `"estetica"`, `"depilacao"`.
- `tipo` aceita o id ou parte do nome: `"consulta"`, `"avaliacao"`.
- Resposta de sucesso: `{ "ok": true, ... }`. Erro: `{ "ok": false, "erro": { "codigo", "mensagem" } }`.

A API nunca marca dois atendimentos no mesmo horário da mesma agenda e só agenda dentro do
horário de atendimento. Encaixes e horários quebrados continuam possíveis pela tela do sistema.

## Agenda

### `POST /agenda/agendas`
Lista agendas, tipos de atendimento (com duração), horários de atendimento e o catálogo de
procedimentos (com o prazo de retorno em meses). Corpo vazio `{}`.

### `POST /agenda/disponibilidade`
```json
{ "data": "2026-11-03", "agenda": "everson", "tipo": "avaliacao" }
```
- `data` ou `data_inicio` + `data_fim` (até 14 dias).
- `agenda`, `tipo` e `duracao_minutos` são opcionais. Sem agenda, traz todas.

```json
{ "ok": true, "disponibilidade": [
  { "data": "2026-11-03", "agenda": { "id": "...", "nome": "Dr. Everson Rezeck" },
    "tipo_id": "...", "duracao_minutos": 20, "horarios": ["08:00", "08:20", "08:40"],
    "detalhes": [{ "inicio": "08:00", "fim": "08:20", "duracao_minutos": 20 }] } ] }
```
A resposta também traz `bloqueios`: os bloqueios do período (da agenda pedida e os da clínica
inteira), para entender por que um horário habitual não aparece.
```json
"bloqueios": [{ "agenda": "Simone Rezeck", "data": "2026-11-26", "inicio": "14:30",
                "data_fim": "2026-11-26", "fim": "15:10", "dia_inteiro": false, "motivo": "exame mapa" }]
```
Um horário só deixa de aparecer quando **cruza** um agendamento ou bloqueio. Encostar não conta:
um horário que começa às 10:00 continua livre se o agendamento ou bloqueio anterior termina às 10:00.

Agendas com horários fixos ("quebrados", como 13:30, 14:00, 14:40) oferecem exatamente esses
horários, e cada um dura até o próximo (limitado pela duração do tipo). Nesse caso
`duracao_minutos` vem `null` porque varia — use `detalhes`.

### `POST /agenda/agendamentos`
Agendamentos de um dia (ou período de até 31 dias).
```json
{ "data": "2026-11-03", "agenda": "simone" }
```
Opcionais: `status` (ex.: `["agendado", "confirmado"]`), `incluir_cancelados: true`.

### `POST /agenda/agendar`
```json
{
  "agenda": "everson",
  "tipo": "consulta",
  "data": "03/11/2026",
  "horario": "09:00",
  "paciente": { "nome": "Carolina Souza", "telefone": "31987654321" },
  "procedimentos": ["Botox"],
  "observacao": "Veio pelo Instagram"
}
```
- Paciente: `paciente_id`, ou o objeto `paciente`. O objeto é procurado pelo CPF e depois pelo
  telefone (com o mesmo primeiro nome — telefone compartilhado entre mãe e filha vira dois
  cadastros). Se não achar, cadastra com os dados enviados (`nome`, `telefone`, `cpf`, `email`,
  `data_nascimento`, `endereco`, `profissao`, `observacoes`).
- `duracao_minutos` é opcional; o padrão é a duração do tipo.
- `procedimentos` é opcional; nomes fora do catálogo são cadastrados com retorno padrão (6 meses).

Resposta: `{ "paciente_cadastrado": true, "agendamento": { ... } }`.

### `POST /agenda/confirmar`
`{ "agendamento_id": "..." }` → status `confirmado`.

### `POST /agenda/remarcar`
`{ "agendamento_id": "...", "data": "2026-11-05", "horario": "14:00" }`
Opcionais: `agenda` (mudar de agenda), `duracao_minutos`. Mantém a duração e volta para
`agendado` (o paciente precisa confirmar o novo horário).

### `POST /agenda/cancelar`
`{ "agendamento_id": "...", "motivo": "Paciente viajou" }`

## Pacientes

### `POST /pacientes/buscar`
Um dos campos: `telefone`, `cpf`, `nome` ou `id`. Para cada paciente encontrado:
`id`, `nome`, `telefone`, `cpf`, `email`, `data_nascimento`, os `proximos_agendamentos` e os
**3 últimos atendimentos em que ele veio** (marcados como "Chegou"), do mais recente para o mais antigo.
```json
{
  "ok": true, "total": 1,
  "pacientes": [{
    "id": "...", "nome": "Maria Souza", "telefone": "(31) 99999-0000", "cpf": "123.456.789-09",
    "email": null, "data_nascimento": "1985-11-02",
    "proximos_agendamentos": [ "...objeto agendamento..." ],
    "ultimos_atendimentos": [
      { "data": "2026-11-18", "agenda": "Dr. Everson Rezeck", "tipo": "Consulta", "procedimentos": ["Ultraformer"] },
      { "data": "2026-06-24", "agenda": "Dr. Everson Rezeck", "tipo": "Consulta", "procedimentos": [] },
      { "data": "2025-09-18", "agenda": "Estética", "tipo": "Consulta", "procedimentos": ["Limpeza de pele"] }
    ],
    "ultimos_atendimentos_texto": "18/11/2026 · Dr. Everson Rezeck: Ultraformer | 24/06/2026 · Dr. Everson Rezeck: Consulta | 18/09/2025 · Estética: Limpeza de pele"
  }]
}
```
Sem procedimento registrado na visita, o texto mostra o tipo do atendimento. Quem nunca veio:
`"ultimos_atendimentos": []` e o texto `"Ainda não fez nenhum atendimento na clínica."`.

### `POST /pacientes/cadastrar`
Mesmos campos do objeto `paciente`. Se já existir (CPF ou telefone + nome), completa os campos
vazios e responde `ja_existia: true`.

### `POST /pacientes/contexto`
Quem é esse número e o que já aconteceu com ele — feito para a IA chamar no início de cada
conversa.
```json
{ "telefone": "5531999990000" }
```
Aceita o telefone em qualquer formato (com ou sem 55, DDD, traços), ou `id`. Um telefone pode
ser de mais de um paciente (mãe e filha): vêm todos, o mais recente primeiro.
```json
{
  "ok": true, "encontrado": true, "total": 1,
  "pacientes": [{
    "paciente": { "id": "...", "nome": "Maria Souza", "primeiro_nome": "Maria", "telefone": "(31) 99999-0000",
                  "telefone_2": null, "whatsapp": "5531999990000", "email": "maria@exemplo.com",
                  "data_nascimento": "1985-11-02", "idade": 40, "aceita_mensagens": true },
    "historico": {
      "total_atendimentos": 12, "primeiro_atendimento": "2015-03-10",
      "ultimo_atendimento": { "agenda": { "nome": "Dr. Everson Rezeck" }, "data": "2026-06-27", "inicio": "15:20", "procedimentos": ["Botox"], "...": "..." },
      "faltas": 1, "cancelamentos": 2,
      "procedimentos_realizados": [{ "nome": "Botox", "vezes": 5, "ultima_vez": "2026-06-27" }],
      "agendas": [{ "nome": "Dr. Everson Rezeck", "atendimentos": 9 }],
      "ultimos_agendamentos": [ "...5 últimos (objeto agendamento)..." ],
      "prontuario": { "anotacoes": 14, "ultima_anotacao": "2026-06-27" }
    },
    "agendamentos_futuros": [{ "agenda": { "nome": "Simone Rezeck" }, "tipo": { "nome": "Consulta" },
                               "data": "2026-11-10", "inicio": "14:00", "fim": "14:40",
                               "status": "confirmado", "procedimentos": [], "observacao": "..." }],
    "retornos_pendentes": [{ "procedimento": "Botox", "ultima_vez": "2026-06-27", "previsto_para": "2026-10-27" }],
    "resumo": "Maria Souza, 40 anos. Paciente desde 2015, 12 atendimento(s); último em 27/06/2026 na agenda Dr. Everson Rezeck (Botox). ... Agendamentos futuros: 10/11/2026 às 14:00 na agenda Simone Rezeck (Consulta) — confirmado pelo paciente."
  }]
}
```
- `ultimos_atendimentos` e `ultimos_atendimentos_texto`: os 3 últimos atendimentos em que o
  paciente veio, no mesmo formato de `pacientes/buscar`.
- `resumo` é um texto pronto para colocar no contexto da IA.
- `agendamentos_futuros` inclui os agendados, confirmados e os que pediram para remarcar.
- O texto do prontuário **não** é enviado (só quantas anotações existem).
- Não encontrado: `{ "ok": true, "encontrado": false, "total": 0, "pacientes": [] }`.

## Objeto agendamento
```json
{
  "id": "...",
  "agenda": { "id": "...", "nome": "Dr. Everson Rezeck" },
  "tipo": { "id": "...", "nome": "Consulta" },
  "paciente": { "id": "...", "nome": "Carolina Souza", "telefone": "31987654321" },
  "data": "2026-11-03", "inicio": "09:00", "fim": "09:40", "duracao_minutos": 40,
  "status": "agendado", "status_descricao": "Agendado (aguardando confirmação)",
  "procedimentos": ["Botox"], "observacao": null, "motivo_cancelamento": null
}
```

Status: `agendado`, `confirmado`, `chegou`, `pediu_remarcar`, `nao_compareceu`, `cancelado`.

## Códigos de erro
| código | HTTP | quando |
|---|---|---|
| `nao_autorizado` | 401 | chave ausente/errada |
| `campo_obrigatorio`, `campo_invalido`, `json_invalido`, `dado_invalido` | 400 | entrada inválida (`detalhes.campo` diz qual) |
| `agenda_ambigua`, `tipo_nao_encontrado`, `tipo_invalido_para_agenda` | 400 | agenda/tipo não identificados |
| `horario_no_passado`, `horario_invalido` | 400 | horário inválido |
| `agenda_nao_encontrada`, `paciente_nao_encontrado`, `agendamento_nao_encontrado` | 404 | |
| `horario_indisponivel` | 409 | já ocupado ou bloqueado |
| `fora_do_horario_de_atendimento` | 409 | fora do expediente da agenda |
| `agendamento_cancelado`, `agendamento_ja_realizado` | 409 | estado não permite a ação |
