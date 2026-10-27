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
Um dos campos: `telefone`, `cpf`, `nome` ou `id`. Traz os próximos agendamentos de cada paciente.

### `POST /pacientes/cadastrar`
Mesmos campos do objeto `paciente`. Se já existir (CPF ou telefone + nome), completa os campos
vazios e responde `ja_existia: true`.

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
