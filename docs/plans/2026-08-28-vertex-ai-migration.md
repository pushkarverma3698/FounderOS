# Vertex AI Migration Task

- [x] Create branch `chore/vertex-migration`
- [x] Install `@langchain/google-vertexai`
- [x] Update `src/agents/model.ts` to use `ChatVertexAI` instead of `ChatGoogleGenerativeAI`
  - [x] Adjust provider logic and imports
  - [x] Handle authentication differences (Vertex uses Application Default Credentials)
- [x] Run `pnpm gate` for proper verification and type checking
- [x] Document changes in `walkthrough.md`
