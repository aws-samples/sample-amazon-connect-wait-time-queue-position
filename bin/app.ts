#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { ConnectEwtStack } from '../lib/connect-ewt-stack';

const app = new cdk.App();

new ConnectEwtStack(app, 'ConnectEWTStack', {
  description:
    'Amazon Connect Estimated Wait Time and Position in Queue. Deploys a Lambda function, ' +
    'associates it with your Connect instance, and creates a Customer Queue Flow that announces ' +
    'EWT and position in queue.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
