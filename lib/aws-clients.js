import { fromIni } from "@aws-sdk/credential-providers";
import { ConnectClient } from "@aws-sdk/client-connect";
import { STSClient } from "@aws-sdk/client-sts";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KinesisClient } from "@aws-sdk/client-kinesis";
import { FirehoseClient } from "@aws-sdk/client-firehose";
import { S3Client } from "@aws-sdk/client-s3";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";

export function client(ServiceClient, profile, region) {
  return new ServiceClient({
    region,
    credentials: fromIni({ profile })
  });
}

export function connectClient(profile, region) {
  return client(ConnectClient, profile, region);
}

export function stsClient(profile, region) {
  return client(STSClient, profile, region);
}

export function lambdaClient(profile, region) {
  return client(LambdaClient, profile, region);
}

export function dynamoClient(profile, region) {
  return client(DynamoDBClient, profile, region);
}

export function kinesisClient(profile, region) {
  return client(KinesisClient, profile, region);
}

export function firehoseClient(profile, region) {
  return client(FirehoseClient, profile, region);
}

export function s3Client(profile, region) {
  return client(S3Client, profile, region);
}

export function cloudWatchClient(profile, region) {
  return client(CloudWatchClient, profile, region);
}

export function eventBridgeClient(profile, region) {
  return client(EventBridgeClient, profile, region);
}

export function cfnClient(profile, region) {
  return client(CloudFormationClient, profile, region);
}
