import "server-only";

import type { CaseCreationRepository, CaseCreationResult } from "../application/service.ts";
import {
  requirePostgreSqlAdapter,
  type PostgreSqlAdapter,
} from "./postgresql.ts";

export class PostgreSqlCaseCreationRepository implements CaseCreationRepository {
  constructor(database: PostgreSqlAdapter) {
    void database;
  }

  async createStudentAndK12Case(
    input: Parameters<CaseCreationRepository["createStudentAndK12Case"]>[0],
  ): Promise<CaseCreationResult> {
    void input;
    throw new Error("CASE_CREATION_LEGACY_PATH_DISABLED");
  }
}

export function createProductionCaseCreationRepository(
  adapter?: PostgreSqlAdapter | null,
): CaseCreationRepository {
  return new PostgreSqlCaseCreationRepository(requirePostgreSqlAdapter(adapter));
}
