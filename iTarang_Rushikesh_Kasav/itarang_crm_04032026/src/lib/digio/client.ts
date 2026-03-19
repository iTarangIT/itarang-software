import axios from "axios";

const BASE_URL = process.env.DIGIO_BASE_URL!;
const CLIENT_ID = process.env.DIGIO_CLIENT_ID!;
const CLIENT_SECRET = process.env.DIGIO_CLIENT_SECRET!;

export const digioClient = axios.create({
  baseURL: BASE_URL,
  auth: {
    username: CLIENT_ID,
    password: CLIENT_SECRET,
  },
  headers: {
    "Content-Type": "application/json",
  },
});