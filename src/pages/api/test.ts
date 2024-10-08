import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIRoute } from "astro";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { PassThrough } from "stream";
import { db } from "@lib/db";
import { chatsTable, reportTable } from "@lib/db/schema";
import { getSession } from "auth-astro/server";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ request }) => {
  const {
    query,
    gender = "f",
    history,
  }: {
    gender: "m" | "f";
    query: string;
    history: { content: string; user: boolean }[];
  } = await request.json();

  console.log({ query, gender, history });

  if (!query) {
    return new Response(null, {
      status: 400,
      statusText: "query is required",
    });
  }

  const session = await getSession(request);

  if (!session?.user?.id) {
    return new Response(null, {
      status: 403,
      statusText: "must be logged in",
    });
  }

  await db.insert(chatsTable).values({
    userId: session.user.id,
    isBot: false,
    content: query,
  });

  const r = await db
    .select({
      report: reportTable.report,
    })
    .from(reportTable)
    .where(eq(reportTable.userId, session.user.id));

  let report = "";

  if (r.length) {
    report = r[0].report;
  }

  const genAI = new GoogleGenerativeAI(import.meta.env.GEMINI_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      candidateCount: 1,
      //maxOutputTokens: 40,
      temperature: 1.0,
    },
    systemInstruction:
      "You are HealthGuide, a compassionate and knowledgeable healthcare advisor. Your mission is to provide specific, evidence-based advice for both physical and mental health inquiries. For example, if a user mentions having a fever, you might advise them to take a fever-reducing medication like paracetamol, apply a cool, wet cloth to their forehead, and stay hydrated. For mental health queries, suggest actionable strategies such as mindfulness or physical activity, while citing reputable sources. Always encourage professional consultation when necessary, and ask relevant follow-up questions to better understand the user's condition or concerns and responses should be concise, clear, and within three sentences, provided in a single paragraph without emojis or special characters." +
      report
        ? ("here is the  medical report of the person whom who are talking to : "+ report + "dont ask patient their personal details")
        : "" ,
  });
  const chat = model.startChat({
    history: history.map((chat) => ({
      role: chat.user ? "user" : "model",
      parts: [{ text: chat.content }],
    })),
  });

  const result = await chat.sendMessage(query);
  const responseText = result.response.text().replace(/[^a-zA-Z ]/g, '');

  await db.insert(chatsTable).values({
    userId: session.user.id,
    isBot: true,
    content: responseText,
  });

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    import.meta.env.SPEECH_KEY,
    import.meta.env.SPEECH_REGION
  );

  const voiceName =
    gender == "f" ? "en-IN-NeerjaNeural" : "en-IN-PrabhatNeural";
  speechConfig.speechSynthesisVoiceName = voiceName;

  const speechSynthesizer = new sdk.SpeechSynthesizer(speechConfig);
  const visemes: number[][] = [];
  speechSynthesizer.visemeReceived = function (s, e) {
    visemes.push([e.audioOffset / 10000, e.visemeId]);
  };

  const audioStream = await new Promise((resolve, reject) => {
    speechSynthesizer.speakTextAsync(
      responseText,
      (result) => {
        const { audioData } = result;

        speechSynthesizer.close();

        // convert arrayBuffer to stream
        const bufferStream = new PassThrough();
        bufferStream.end(Buffer.from(audioData));
        resolve(bufferStream);
      },
      (error) => {
        console.log(error);
        speechSynthesizer.close();
        reject(error);
      }
    );
  });

  //@ts-ignore
  const buffer = await streamToBuffer(audioStream);

  // Convert the buffer to base64
  const audioBase64 = buffer.toString("base64");

  return new Response(
    JSON.stringify({
      text: responseText,
      visemes: visemes,
      audio: audioBase64,
    })
  );
};

const streamToBuffer = async (stream: PassThrough): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      chunks.push(chunk);
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", (err) => {
      reject(err);
    });
  });
};
