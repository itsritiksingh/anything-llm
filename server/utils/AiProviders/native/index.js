const fs = require("fs");
const path = require("path");
const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const { chatPrompt } = require("../../chats");

// Docs: https://api.js.langchain.com/classes/chat_models_llama_cpp.ChatLlamaCpp.html
const ChatLlamaCpp = (...args) =>
  import("langchain/chat_models/llama_cpp").then(
    ({ ChatLlamaCpp }) => new ChatLlamaCpp(...args)
  );

class NativeLLM {
  constructor(embedder = null) {
    if (!process.env.NATIVE_LLM_MODEL_PREF)
      throw new Error("No local Llama model was set.");

    this.model = process.env.NATIVE_LLM_MODEL_PREF || null;
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };
    this.embedder = embedder || new NativeEmbedder();
    this.cacheDir = path.resolve(
      process.env.STORAGE_DIR
        ? path.resolve(process.env.STORAGE_DIR, "models", "downloaded")
        : path.resolve(__dirname, `../../../storage/models/downloaded`)
    );

    // Make directory when it does not exist in existing installations
    if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir);
  }

  async #initializeLlamaModel(temperature = 0.7) {
    const modelPath = path.join(this.cacheDir, this.model);
    if (!fs.existsSync(modelPath))
      throw new Error(
        `Local Llama model ${this.model} was not found in storage!`
      );

    global.llamaModelInstance = await ChatLlamaCpp({
      modelPath,
      temperature,
      useMlock: true,
    });
  }

  // If the model has been loaded once, it is in the memory now
  // so we can skip  re-loading it and instead go straight to inference.
  // Note: this will break temperature setting hopping between workspaces with different temps.
  async #llamaClient({ temperature = 0.7 }) {
    if (global.llamaModelInstance) return global.llamaModelInstance;
    await this.#initializeLlamaModel(temperature);
    return global.llamaModelInstance;
  }

  #convertToLangchainPrototypes(chats = []) {
    const {
      HumanMessage,
      SystemMessage,
      AIMessage,
    } = require("langchain/schema");
    const langchainChats = [];
    const roleToMessageMap = {
      system: SystemMessage,
      user: HumanMessage,
      assistant: AIMessage,
    };

    for (const chat of chats) {
      if (!roleToMessageMap.hasOwnProperty(chat.role)) continue;
      const MessageClass = roleToMessageMap[chat.role];
      langchainChats.push(new MessageClass({ content: chat.content }));
    }

    return langchainChats;
  }

  #appendContext(contextTexts = []) {
    if (!contextTexts || !contextTexts.length) return "";
    return (
      "\nContext:\n" +
      contextTexts
        .map((text, i) => {
          return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
        })
        .join("")
    );
  }

  streamingEnabled() {
    return "streamChat" in this && "streamGetChatCompletion" in this;
  }

  // Ensure the user set a value for the token limit
  // and if undefined - assume 4096 window.
  // DEV: Currently this ENV is not configurable.
  promptWindowLimit() {
    const limit = process.env.NATIVE_LLM_MODEL_TOKEN_LIMIT || 4096;
    if (!limit || isNaN(Number(limit)))
      throw new Error("No NativeAI token context limit was set.");
    return Number(limit);
  }

  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
  }) {
    const prompt = {
      role: "system",
      content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
    };
    return [prompt, ...chatHistory, { role: "user", content: userPrompt }];
  }

  async isSafe(_input = "") {
    // Not implemented so must be stubbed
    return { safe: true, reasons: [] };
  }

  async sendChat(chatHistory = [], prompt, workspace = {}, rawHistory = []) {
    try {
      const messages = await this.compressMessages(
        {
          systemPrompt: chatPrompt(workspace),
          userPrompt: prompt,
          chatHistory,
        },
        rawHistory
      );

      const model = await this.#llamaClient({
        temperature: Number(workspace?.openAiTemp ?? 0.7),
      });
      const response = await model.call(messages);
      return response.content;
    } catch (error) {
      throw new Error(
        `NativeLLM::createChatCompletion failed with: ${error.message}`
      );
    }
  }

  async streamChat(chatHistory = [], prompt, workspace = {}, rawHistory = []) {
    const model = await this.#llamaClient({
      temperature: Number(workspace?.openAiTemp ?? 0.7),
    });
    const messages = await this.compressMessages(
      {
        systemPrompt: chatPrompt(workspace),
        userPrompt: prompt,
        chatHistory,
      },
      rawHistory
    );
    const responseStream = await model.stream(messages);
    return responseStream;
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    const model = await this.#llamaClient({ temperature });
    const response = await model.call(messages);
    return response.content;
  }

  async streamGetChatCompletion(messages = null, { temperature = 0.7 }) {
    const model = await this.#llamaClient({ temperature });
    const responseStream = await model.stream(messages);
    return responseStream;
  }

  // Simple wrapper for dynamic embedder & normalize interface for all LLM implementations
  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    const compressedMessages = await messageArrayCompressor(
      this,
      messageArray,
      rawHistory
    );
    return this.#convertToLangchainPrototypes(compressedMessages);
  }
}

module.exports = {
  NativeLLM,
};
