import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

/**
 * Object storage helper — MinIO in development, NDC object storage in
 * production (both S3-compatible). PDFs and other artifacts only; PII rules
 * follow the credential record they belong to (sovereign tier).
 */

export interface StorageConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export function storageConfigFromEnv(): StorageConfig {
  return {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9002",
    accessKey: process.env.S3_ACCESS_KEY ?? "diplommn",
    secretKey: process.env.S3_SECRET_KEY ?? "diplommn_dev",
    bucket: process.env.S3_BUCKET ?? "diplommn-artifacts",
  };
}

export interface Storage {
  bucket: string;
  client: S3Client;
  ensureBucket(): Promise<void>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObjectStream(key: string): Promise<{
    stream: Readable;
    contentType: string | undefined;
    contentLength: number | undefined;
  }>;
}

export function createStorage(config: StorageConfig = storageConfigFromEnv()): Storage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "us-east-1", // ignored by MinIO/NDC but required by the SDK
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true, // MinIO-compatible addressing
  });

  return {
    bucket: config.bucket,
    client,
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
      }
    },
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async getObjectStream(key) {
      const res = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      return {
        stream: res.Body as Readable,
        contentType: res.ContentType,
        contentLength: res.ContentLength,
      };
    },
  };
}
