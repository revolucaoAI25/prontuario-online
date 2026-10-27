# Webhooks de lembrete e aniversário

Todo dia às 9h (horário de Brasília) o sistema manda um `POST` com JSON para cada lembrete de
retorno vencido e para cada aniversariante do dia, nas URLs configuradas em
**Ajustes → Integrações** (visível só para o super admin). É ali que o fluxo (n8n, Chatflux…) decide o texto e envia
a mensagem.

- Uma chamada por lembrete/aniversariante. Responder qualquer `2xx` marca como enviado.
- Resposta fora de `2xx` (ou mais de 10 s sem responder): tenta de novo mais tarde, até 5 vezes.
- Com `WEBHOOK_SIGNING_SECRET` definido na Vercel, cada chamada traz
  `x-clinica-assinatura: sha256=<HMAC-SHA256 do corpo>` para o receptor conferir.
- Não são enviados: pacientes marcados como "não receber mensagens", sem telefone, ou que já têm
  um agendamento futuro (agendado/confirmado) — esses esperam para ver se o paciente refaz o
  procedimento. Lembretes atrasados mais que a tolerância (padrão 30 dias) também não.

## Lembrete de retorno

| Campo | O que é |
|---|---|
| `paciente` | dados de contato: nome, primeiro nome, telefones, `whatsapp` (com 55), e-mail, nascimento, idade |
| `procedimento` | o procedimento do retorno e o prazo dele em meses |
| `data_ultima_vez` | quando o paciente fez esse procedimento pela última vez |
| `dias_desde_ultima_vez` | quantos dias se passaram desde então |
| `vezes_que_fez` | quantas vezes já fez esse procedimento na clínica |
| `data_retorno_prevista` | a data prevista para voltar (última vez + prazo, ou a data ajustada à mão) |
| `atendimento_de_origem` | o atendimento em que fez o procedimento: agenda, tipo, data, horário, todos os procedimentos daquele dia |
| `criado_manualmente`, `observacao` | se a equipe criou o lembrete à mão, e a observação dele |
| `outros_retornos_pendentes` | outros retornos previstos do mesmo paciente |
| `agendamentos_futuros` | o que já está marcado (em geral vazio, já que quem tem horário marcado não recebe o lembrete; pode trazer um agendamento com status "pediu para remarcar") |
| `historico` | o mesmo resumo da API `/pacientes/contexto`: total de atendimentos, último atendimento, faltas, procedimentos já feitos, agendas, últimos agendamentos |
| `resumo` | o histórico em uma frase, pronto para a IA |
| `tentativa` | 1 na primeira vez; aumenta a cada reenvio |

Exemplo completo:
```json
{
  "tipo": "lembrete_retorno",
  "lembrete_id": "…",
  "tentativa": 1,
  "paciente": {
    "id": "…",
    "nome": "Maria Souza",
    "primeiro_nome": "Maria",
    "telefone": "(31) 99999-0000",
    "telefone_2": null,
    "whatsapp": "5531999990000",
    "email": "maria@exemplo.com",
    "data_nascimento": "1985-11-02",
    "idade": 40,
    "aceita_mensagens": true
  },
  "procedimento": {
    "id": "…",
    "nome": "Botox",
    "retorno_em_meses": 4
  },
  "data_ultima_vez": "2026-06-27",
  "dias_desde_ultima_vez": 122,
  "vezes_que_fez": 1,
  "data_retorno_prevista": "2026-10-27",
  "atendimento_de_origem": {
    "id": "…",
    "agenda": {
      "id": "…",
      "nome": "Dr. Everson Rezeck"
    },
    "tipo": {
      "id": "…",
      "nome": "Consulta"
    },
    "data": "2026-06-27",
    "inicio": "15:20",
    "fim": "16:00",
    "duracao_minutos": 40,
    "status": "chegou",
    "status_descricao": "Paciente chegou",
    "procedimentos": [
      "Botox",
      "Preenchimento com ácido hialurônico"
    ],
    "observacao": null,
    "motivo_cancelamento": null
  },
  "criado_manualmente": false,
  "observacao": null,
  "outros_retornos_pendentes": [
    {
      "procedimento": "Preenchimento com ácido hialurônico",
      "ultima_vez": "2026-06-27",
      "previsto_para": "2027-06-27"
    }
  ],
  "agendamentos_futuros": [],
  "historico": {
    "total_atendimentos": 1,
    "primeiro_atendimento": "2026-06-27",
    "ultimo_atendimento": {
      "id": "…",
      "agenda": {
        "id": "…",
        "nome": "Dr. Everson Rezeck"
      },
      "tipo": {
        "id": "…",
        "nome": "Consulta"
      },
      "data": "2026-06-27",
      "inicio": "15:20",
      "fim": "16:00",
      "duracao_minutos": 40,
      "status": "chegou",
      "status_descricao": "Paciente chegou",
      "procedimentos": [
        "Botox",
        "Preenchimento com ácido hialurônico"
      ],
      "observacao": null,
      "motivo_cancelamento": null
    },
    "faltas": 0,
    "cancelamentos": 0,
    "procedimentos_realizados": [
      {
        "nome": "Botox",
        "vezes": 1,
        "ultima_vez": "2026-06-27"
      },
      {
        "nome": "Preenchimento com ácido hialurônico",
        "vezes": 1,
        "ultima_vez": "2026-06-27"
      }
    ],
    "agendas": [
      {
        "nome": "Dr. Everson Rezeck",
        "atendimentos": 1
      }
    ],
    "ultimos_agendamentos": [
      {
        "id": "…",
        "agenda": {
          "id": "…",
          "nome": "Dr. Everson Rezeck"
        },
        "tipo": {
          "id": "…",
          "nome": "Consulta"
        },
        "data": "2026-06-27",
        "inicio": "15:20",
        "fim": "16:00",
        "duracao_minutos": 40,
        "status": "chegou",
        "status_descricao": "Paciente chegou",
        "procedimentos": [
          "Botox",
          "Preenchimento com ácido hialurônico"
        ],
        "observacao": null,
        "motivo_cancelamento": null
      }
    ],
    "prontuario": {
      "anotacoes": 0,
      "ultima_anotacao": null
    }
  },
  "resumo": "Maria Souza, 40 anos. Paciente desde 2026, 1 atendimento(s); último em 27/06/2026 na agenda Dr. Everson Rezeck (Botox, Preenchimento com ácido hialurônico). Procedimentos já feitos: Botox (1x, última em 27/06/2026); Preenchimento com ácido hialurônico (1x, última em 27/06/2026). Sem agendamentos futuros. Retornos previstos: Botox em 27/10/2026; Preenchimento com ácido hialurônico em 27/06/2027."
}
```

## Aniversário
```json
{
  "tipo": "aniversario",
  "mensagem_id": "…",
  "paciente": { "id": "…", "nome": "Maria Souza", "primeiro_nome": "Maria", "telefone": "(31) 99999-0000",
                "telefone_2": null, "whatsapp": "5531999990000", "email": "maria@exemplo.com",
                "data_nascimento": "1985-11-02", "idade": 41, "aceita_mensagens": true },
  "data_nascimento": "1985-11-02",
  "idade": 41,
  "agendamentos_futuros": [],
  "tentativa": 1
}
```
