import { defineComposeGlobalSetup } from "vitecompose/node";

export type SwarmE2eConfig = {
  boardOrigin: string;
  boardUrl: string;
  boardToken: string;
};

declare module "vitest" {
  export interface ProvidedContext {
    swarmE2e: SwarmE2eConfig;
  }
}

export default defineComposeGlobalSetup({
  stack: {
    name: "bordr-swarm-e2e",
    composeFile: "./docker-compose.yaml",
    reuse: process.env.SWARM_E2E_FRESH !== "1",
  },
  environment: {
    rootDir: "../..",
    images: [
      {
        name: "bordr-swarm-e2e-board",
        dockerfile: "tests/e2e/board/Dockerfile",
        context: "tests/e2e/board",
      },
      {
        name: "bordr-swarm-e2e-worker",
        dockerfile: "tests/e2e/worker/Dockerfile",
        context: ".",
      },
    ],
    stages: [
      {
        name: "board",
        images: ["bordr-swarm-e2e-board"],
        services: ["board"],
        waitFor: ["board"],
      },
      {
        name: "workers",
        dependsOn: ["board"],
        images: ["bordr-swarm-e2e-worker"],
        inputs: ["src/**", "prompts/**"],
        services: ["worker-1", "worker-2"],
        waitFor: ["worker-1", "worker-2"],
      },
    ],
  },
  setup: async ({ compose, provide }) => {
    await compose.waitForHttp("board", 4100, { path: "/healthz", timeoutMs: 30_000 });
    const boardOrigin = await compose.url("board", 4100);
    provide("swarmE2e", {
      boardOrigin,
      boardUrl: `${boardOrigin}/api/board`,
      boardToken: "bordr-e2e-test-token",
    });
  },
});
