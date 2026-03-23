import { digioClient } from "./client";
import { buildDigioPayload } from "./mapper";

export async function createDigioAgreement(data: any) {
  const payload = buildDigioPayload(data);

  const response = await digioClient.post("/v2/client/document/create", payload);

  return response.data;
}