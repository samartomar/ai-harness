import { config } from "zod";

// Run before constructing browser schemas: no eval, including capability probes.
config({ jitless: true });
