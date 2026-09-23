#!/usr/bin/env python3
"""Migrates clinical data from a restored FastClinic SQL Server backup into
the Postgres/Supabase schema defined in supabase/migrations/.

Usage:
    python3 migrate_fastclinic.py

Connection settings come from environment variables (see .env.example):
    MSSQL_HOST, MSSQL_PORT, MSSQL_USER, MSSQL_PASSWORD, MSSQL_DB
    DATABASE_URL   (Postgres/Supabase connection string)

Safe to re-run: every insert is an upsert keyed on legacy_id, so running this
again against a fresher backup (e.g. the final sync before cutover) updates
existing rows instead of duplicating them.
"""
import os
import sys
import json
import datetime
import decimal

import pymssql
import psycopg2
import psycopg2.extras


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and not value:
        sys.exit(f"Missing required environment variable: {name}")
    return value


def json_default(value):
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, bytes):
        return None  # e.g. the `foto` image column; not needed for the clinical record
    raise TypeError(f"Cannot serialize {type(value)}")


def row_to_raw_json(row):
    return json.dumps(dict(row), default=json_default, ensure_ascii=False)


def to_bool(value):
    if value is None:
        return None
    return str(value).strip().upper() == "S"


def connect_mssql():
    return pymssql.connect(
        server=env("MSSQL_HOST", "localhost"),
        port=env("MSSQL_PORT", "1433"),
        user=env("MSSQL_USER", "sa"),
        password=env("MSSQL_PASSWORD", required=True),
        database=env("MSSQL_DB", "clinica"),
        as_dict=True,
    )


def connect_postgres():
    return psycopg2.connect(env("DATABASE_URL", required=True))


def migrate_patients(mssql_cur, pg_cur):
    mssql_cur.execute("""
        SELECT Seq, Codigo, Nome, Cnpj_cpf, nascimento, sexo, Fone, Celular, Email,
               Endereco, numero, Bairro, complemento, Municipio, Uf, Cep,
               datacad, dtmodificacao
        FROM Pessoas
    """)
    rows = mssql_cur.fetchall()
    for row in rows:
        psycopg2.extras.execute_values  # noqa: keep import used for clarity below
        pg_cur.execute(
            """
            insert into patients (
                legacy_id, legacy_code, full_name, cpf, birth_date, sex,
                phone, mobile_phone, email, address_street, address_number,
                address_neighborhood, address_complement, address_city,
                address_state, address_zip, registered_at, legacy_updated_at, raw
            ) values (
                %(Seq)s, %(Codigo)s, %(Nome)s, %(Cnpj_cpf)s, %(nascimento)s, %(sexo)s,
                %(Fone)s, %(Celular)s, %(Email)s, %(Endereco)s, %(numero)s,
                %(Bairro)s, %(complemento)s, %(Municipio)s, %(Uf)s, %(Cep)s,
                %(datacad)s, %(dtmodificacao)s, %(raw)s
            )
            on conflict (legacy_id) do update set
                legacy_code = excluded.legacy_code,
                full_name = excluded.full_name,
                cpf = excluded.cpf,
                birth_date = excluded.birth_date,
                sex = excluded.sex,
                phone = excluded.phone,
                mobile_phone = excluded.mobile_phone,
                email = excluded.email,
                address_street = excluded.address_street,
                address_number = excluded.address_number,
                address_neighborhood = excluded.address_neighborhood,
                address_complement = excluded.address_complement,
                address_city = excluded.address_city,
                address_state = excluded.address_state,
                address_zip = excluded.address_zip,
                registered_at = excluded.registered_at,
                legacy_updated_at = excluded.legacy_updated_at,
                raw = excluded.raw
            """,
            {**row, "raw": row_to_raw_json(row)},
        )
    return len(rows)


def migrate_appointments(mssql_cur, pg_cur):
    mssql_cur.execute("""
        SELECT a.SEQ, a.SEQCLIENTE, a.DATTA, a.HORARIO, a.CONFIRMADO, a.ATENDIDO,
               a.DESMARCAR, a.MOTIVO, a.OBSERVACAO, a.RESPONSAVEL, a.DTMODIFICACAO
        FROM ATENDIMENTOS a
    """)
    rows = mssql_cur.fetchall()
    for row in rows:
        scheduled_at = row["HORARIO"] or row["DATTA"]
        pg_cur.execute(
            """
            insert into appointments (
                legacy_id, patient_id, scheduled_at, confirmed, attended,
                cancelled, cancel_reason, observation, responsible,
                legacy_updated_at, raw
            ) values (
                %(legacy_id)s,
                (select id from patients where legacy_id = %(patient_legacy_id)s),
                %(scheduled_at)s, %(confirmed)s, %(attended)s, %(cancelled)s,
                %(cancel_reason)s, %(observation)s, %(responsible)s,
                %(legacy_updated_at)s, %(raw)s
            )
            on conflict (legacy_id) do update set
                patient_id = excluded.patient_id,
                scheduled_at = excluded.scheduled_at,
                confirmed = excluded.confirmed,
                attended = excluded.attended,
                cancelled = excluded.cancelled,
                cancel_reason = excluded.cancel_reason,
                observation = excluded.observation,
                responsible = excluded.responsible,
                legacy_updated_at = excluded.legacy_updated_at,
                raw = excluded.raw
            """,
            {
                "legacy_id": row["SEQ"],
                "patient_legacy_id": row["SEQCLIENTE"],
                "scheduled_at": scheduled_at,
                "confirmed": to_bool(row["CONFIRMADO"]),
                "attended": to_bool(row["ATENDIDO"]),
                "cancelled": to_bool(row["DESMARCAR"]),
                "cancel_reason": row["MOTIVO"],
                "observation": row["OBSERVACAO"],
                "responsible": row["RESPONSAVEL"],
                "legacy_updated_at": row["DTMODIFICACAO"],
                "raw": row_to_raw_json(row),
            },
        )
    return len(rows)


def migrate_medical_records(mssql_cur, pg_cur):
    mssql_cur.execute("""
        SELECT SEQ, SEQCLIENTE, TRATAMENTO, OBITO, DATAOBITO, CAUSAOBITO,
               INTERNACAO, DATAINTERNACAO, DATAALTA, DTMODIFICACAO
        FROM PRONTUARIOS
    """)
    rows = mssql_cur.fetchall()
    skipped = 0
    for row in rows:
        pg_cur.execute("select id from patients where legacy_id = %s", (row["SEQCLIENTE"],))
        if pg_cur.fetchone() is None:
            skipped += 1
            continue
        pg_cur.execute(
            """
            insert into medical_records (
                legacy_id, patient_id, treatment, death_flag, death_date,
                death_cause, hospitalization_flag, hospitalization_date,
                discharge_date, legacy_updated_at, raw
            ) values (
                %(SEQ)s,
                (select id from patients where legacy_id = %(SEQCLIENTE)s),
                %(TRATAMENTO)s, %(death_flag)s, %(DATAOBITO)s, %(CAUSAOBITO)s,
                %(hospitalization_flag)s, %(DATAINTERNACAO)s, %(DATAALTA)s,
                %(DTMODIFICACAO)s, %(raw)s
            )
            on conflict (legacy_id) do update set
                patient_id = excluded.patient_id,
                treatment = excluded.treatment,
                death_flag = excluded.death_flag,
                death_date = excluded.death_date,
                death_cause = excluded.death_cause,
                hospitalization_flag = excluded.hospitalization_flag,
                hospitalization_date = excluded.hospitalization_date,
                discharge_date = excluded.discharge_date,
                legacy_updated_at = excluded.legacy_updated_at,
                raw = excluded.raw
            """,
            {
                **row,
                "death_flag": to_bool(row["OBITO"]),
                "hospitalization_flag": to_bool(row["INTERNACAO"]),
                "raw": row_to_raw_json(row),
            },
        )
    return len(rows), skipped


def migrate_clinical_notes(mssql_cur, pg_cur):
    mssql_cur.execute("""
        SELECT SEQ, SEQPRONTUARIO, seqatendimento, datta, horario, QUEIXA,
               HISTORIA, ANAMNESE, EX_FISICO, CONDUTA, MEDIC, OUTRAS_ANOTACOES,
               alergia, PESOATUAL, altura, PA, FC, FR, TAX, CANCELADO,
               DTATUALIZACAO
        FROM PRONTUARIOS_EVOLUCAO
    """)
    rows = mssql_cur.fetchall()
    skipped = 0
    for row in rows:
        pg_cur.execute("select id from medical_records where legacy_id = %s", (row["SEQPRONTUARIO"],))
        if pg_cur.fetchone() is None:
            skipped += 1
            continue
        note_at = row["horario"] or row["datta"]
        pg_cur.execute(
            """
            insert into clinical_notes (
                legacy_id, medical_record_id, appointment_id, note_at,
                chief_complaint, history, anamnesis, physical_exam, conduct,
                medications, other_notes, allergy, weight_kg, height_cm,
                blood_pressure, heart_rate, respiratory_rate, temperature,
                cancelled, legacy_updated_at, raw
            ) values (
                %(SEQ)s,
                (select id from medical_records where legacy_id = %(SEQPRONTUARIO)s),
                (select id from appointments where legacy_id = %(seqatendimento)s),
                %(note_at)s, %(QUEIXA)s, %(HISTORIA)s, %(ANAMNESE)s, %(EX_FISICO)s,
                %(CONDUTA)s, %(MEDIC)s, %(OUTRAS_ANOTACOES)s, %(alergia)s,
                %(PESOATUAL)s, %(altura)s, %(PA)s, %(FC)s, %(FR)s, %(TAX)s,
                %(cancelled)s, %(DTATUALIZACAO)s, %(raw)s
            )
            on conflict (legacy_id) do update set
                medical_record_id = excluded.medical_record_id,
                appointment_id = excluded.appointment_id,
                note_at = excluded.note_at,
                chief_complaint = excluded.chief_complaint,
                history = excluded.history,
                anamnesis = excluded.anamnesis,
                physical_exam = excluded.physical_exam,
                conduct = excluded.conduct,
                medications = excluded.medications,
                other_notes = excluded.other_notes,
                allergy = excluded.allergy,
                weight_kg = excluded.weight_kg,
                height_cm = excluded.height_cm,
                blood_pressure = excluded.blood_pressure,
                heart_rate = excluded.heart_rate,
                respiratory_rate = excluded.respiratory_rate,
                temperature = excluded.temperature,
                cancelled = excluded.cancelled,
                legacy_updated_at = excluded.legacy_updated_at,
                raw = excluded.raw
            """,
            {
                **row,
                "note_at": note_at,
                "cancelled": to_bool(row["CANCELADO"]),
                "raw": row_to_raw_json(row),
            },
        )
    return len(rows), skipped


def main():
    mssql_conn = connect_mssql()
    pg_conn = connect_postgres()
    mssql_cur = mssql_conn.cursor()
    pg_cur = pg_conn.cursor()

    n_patients = migrate_patients(mssql_cur, pg_cur)
    pg_conn.commit()
    print(f"patients: {n_patients} upserted")

    n_appt = migrate_appointments(mssql_cur, pg_cur)
    pg_conn.commit()
    print(f"appointments: {n_appt} upserted")

    n_records, skip_records = migrate_medical_records(mssql_cur, pg_cur)
    pg_conn.commit()
    print(f"medical_records: {n_records - skip_records} upserted, {skip_records} skipped (no matching patient)")

    n_notes, skip_notes = migrate_clinical_notes(mssql_cur, pg_cur)
    pg_conn.commit()
    print(f"clinical_notes: {n_notes - skip_notes} upserted, {skip_notes} skipped (no matching medical_record)")

    mssql_cur.close()
    pg_cur.close()
    mssql_conn.close()
    pg_conn.close()


if __name__ == "__main__":
    main()
