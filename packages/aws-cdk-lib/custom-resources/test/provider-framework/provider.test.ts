import { Match, Template } from '../../../assertions';
import * as ec2 from '../../../aws-ec2';
import * as iam from '../../../aws-iam';
import * as kms from '../../../aws-kms';
import * as lambda from '../../../aws-lambda';
import * as logs from '../../../aws-logs';
import { LogLevel } from '../../../aws-stepfunctions';
import { App, Duration, Stack } from '../../../core';
import * as cxapi from '../../../cx-api';
import * as cr from '../../lib';
import * as util from '../../lib/provider-framework/util';

test('security groups are applied to all framework functions', () => {
  // GIVEN
  const stack = new Stack();

  const vpc = new ec2.Vpc(stack, 'Vpc');
  const securityGroup = new ec2.SecurityGroup(stack, 'SecurityGroup', { vpc });

  // WHEN
  new cr.Provider(stack, 'MyProvider', {
    onEventHandler: new lambda.Function(stack, 'OnEvent', {
      code: lambda.Code.fromInline('foo'),
      handler: 'index.onEvent',
      runtime: lambda.Runtime.NODEJS_LATEST,
    }),
    isCompleteHandler: new lambda.Function(stack, 'IsComplete', {
      code: lambda.Code.fromInline('foo'),
      handler: 'index.isComplete',
      runtime: lambda.Runtime.NODEJS_LATEST,
    }),
    vpc: vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [securityGroup],
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onEvent',
    VpcConfig: {
      SecurityGroupIds: [
        {
          'Fn::GetAtt': [
            'SecurityGroupDD263621',
            'GroupId',
          ],
        },
      ],
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.isComplete',
    VpcConfig: {
      SecurityGroupIds: [
        {
          'Fn::GetAtt': [
            'SecurityGroupDD263621',
            'GroupId',
          ],
        },
      ],
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onTimeout',
    VpcConfig: {
      SecurityGroupIds: [
        {
          'Fn::GetAtt': [
            'SecurityGroupDD263621',
            'GroupId',
          ],
        },
      ],
    },
  });
});

test('vpc is applied to all framework functions', () => {
  // GIVEN
  const stack = new Stack();

  const vpc = new ec2.Vpc(stack, 'Vpc');

  // WHEN
  new cr.Provider(stack, 'MyProvider', {
    onEventHandler: new lambda.Function(stack, 'OnEvent', {
      code: lambda.Code.fromInline('foo'),
      handler: 'index.onEvent',
      runtime: lambda.Runtime.NODEJS_LATEST,
    }),
    isCompleteHandler: new lambda.Function(stack, 'IsComplete', {
      code: lambda.Code.fromInline('foo'),
      handler: 'index.isComplete',
      runtime: lambda.Runtime.NODEJS_LATEST,
    }),
    vpc: vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onEvent',
    VpcConfig: {
      SubnetIds: [
        { Ref: 'VpcPrivateSubnet1Subnet536B997A' },
        { Ref: 'VpcPrivateSubnet2Subnet3788AAA1' },
      ],
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.isComplete',
    VpcConfig: {
      SubnetIds: [
        { Ref: 'VpcPrivateSubnet1Subnet536B997A' },
        { Ref: 'VpcPrivateSubnet2Subnet3788AAA1' },
      ],
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onTimeout',
    VpcConfig: {
      SubnetIds: [
        { Ref: 'VpcPrivateSubnet1Subnet536B997A' },
        { Ref: 'VpcPrivateSubnet2Subnet3788AAA1' },
      ],
    },
  });
});

test('minimal setup', () => {
  // GIVEN
  const stack = new Stack();

  // WHEN
  new cr.Provider(stack, 'MyProvider', {
    onEventHandler: new lambda.Function(stack, 'MyHandler', {
      code: new lambda.InlineCode('foo'),
      handler: 'index.onEvent',
      runtime: lambda.Runtime.NODEJS_LATEST,
    }),
  });

  // THEN

  // framework "onEvent" handler
  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onEvent',
    Environment: { Variables: { USER_ON_EVENT_FUNCTION_ARN: { 'Fn::GetAtt': ['MyHandler6B74D312', 'Arn'] } } },
    Timeout: 900,
  });

  // user "onEvent" handler
  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.onEvent',
  });

  // no framework "is complete" handler or state machine
  Template.fromStack(stack).resourceCountIs('AWS::StepFunctions::StateMachine', 0);
  expect(Template.fromStack(stack).findResources('AWS::Lambda::Function', {
    Handler: 'framework.isComplete',
    Timeout: 900,
  })).toEqual({});
});

test('if isComplete is specified, the isComplete framework handler is also included', () => {
  // GIVEN
  const stack = new Stack();
  const handler = new lambda.Function(stack, 'MyHandler', {
    code: new lambda.InlineCode('foo'),
    handler: 'index.onEvent',
    runtime: lambda.Runtime.NODEJS_LATEST,
  });

  // WHEN
  new cr.Provider(stack, 'MyProvider', {
    onEventHandler: handler,
    isCompleteHandler: handler,
    waiterStateMachineLogOptions: {
      includeExecutionData: true,
      level: LogLevel.ALL,
    },
  });

  // THEN

  // framework "onEvent" handler
  const expectedEnv = {
    Variables: {
      USER_ON_EVENT_FUNCTION_ARN: { 'Fn::GetAtt': ['MyHandler6B74D312', 'Arn'] },
      USER_IS_COMPLETE_FUNCTION_ARN: { 'Fn::GetAtt': ['MyHandler6B74D312', 'Arn'] },
    },
  };

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onEvent',
    Timeout: 900,
    Environment: {
      Variables: {
        ...expectedEnv.Variables,
        WAITER_STATE_MACHINE_ARN: { Ref: 'MyProviderwaiterstatemachineC1FBB9F9' },
      },
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.isComplete',
    Timeout: 900,
    Environment: expectedEnv,
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onTimeout',
    Timeout: 900,
    Environment: expectedEnv,
  });

  Template.fromStack(stack).hasResourceProperties('AWS::StepFunctions::StateMachine', {
    DefinitionString: {
      'Fn::Join': [
        '',
        [
          '{"StartAt":"framework-isComplete-task","States":{"framework-isComplete-task":{"End":true,"Retry":[{"ErrorEquals":["States.ALL"],"IntervalSeconds":5,"MaxAttempts":360,"BackoffRate":1}],"Catch":[{"ErrorEquals":["States.ALL"],"Next":"framework-onTimeout-task"}],"Type":"Task","Resource":"',
          {
            'Fn::GetAtt': [
              'MyProviderframeworkisComplete364190E2',
              'Arn',
            ],
          },
          '"},"framework-onTimeout-task":{"End":true,"Type":"Task","Resource":"',
          {
            'Fn::GetAtt': [
              'MyProviderframeworkonTimeoutD9D96588',
              'Arn',
            ],
          },
          '"}}}',
        ],
      ],
    },
  });
});

test('LoggingConfiguration will be not be created if waiterStateMachineLogOptions is not specified', () => {
  // GIVEN
  const stack = new Stack();
  const handler = new lambda.Function(stack, 'MyHandler', {
    code: new lambda.InlineCode('foo'),
    handler: 'index.onEvent',
    runtime: lambda.Runtime.NODEJS_LATEST,
  });

  // WHEN
  new cr.Provider(stack, 'MyProvider', {
    onEventHandler: handler,
    isCompleteHandler: handler,
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::StepFunctions::StateMachine', {
    LoggingConfiguration: Match.absent(),
  });
});

test('a default LoggingConfiguration will not be created if disableWaiterStateMachineLogging is true', () => {
  // GIVEN
  const stack = new Stack();
  const handler = new lambda.Function(stack, 'MyHandler', {
    code: new lambda.InlineCode('foo'),
    handler: 'index.onEvent',
    runtime: lambda.Runtime.NODEJS_LATEST,
  });

  // WHEN
  new cr.Provider(stack, 'MyProvider', {
    onEventHandler: handler,
    isCompleteHandler: handler,
    disableWaiterStateMachineLogging: true,
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::StepFunctions::StateMachine', {
    LoggingConfiguration: Match.absent(),
  });
});

test('fails if "queryInterval" or "totalTimeout" or "waiterStateMachineLogOptions" or "disableWaiterStateMachineLogging" are set without "isCompleteHandler"', () => {
  // GIVEN
  const stack = new Stack();
  const handler = new lambda.Function(stack, 'MyHandler', {
    code: new lambda.InlineCode('foo'),
    handler: 'index.onEvent',
    runtime: lambda.Runtime.NODEJS_LATEST,
  });

  // THEN
  expect(() => new cr.Provider(stack, 'provider1', {
    onEventHandler: handler,
    queryInterval: Duration.seconds(10),
  })).toThrow(/\"queryInterval\", \"totalTimeout\", \"waiterStateMachineLogOptions\", and \"disableWaiterStateMachineLogging\" can only be configured if \"isCompleteHandler\" is specified. Otherwise, they have no meaning/);

  expect(() => new cr.Provider(stack, 'provider2', {
    onEventHandler: handler,
    totalTimeout: Duration.seconds(100),
  })).toThrow(/\"queryInterval\", \"totalTimeout\", \"waiterStateMachineLogOptions\", and \"disableWaiterStateMachineLogging\" can only be configured if \"isCompleteHandler\" is specified. Otherwise, they have no meaning/);

  expect(() => new cr.Provider(stack, 'provider3', {
    onEventHandler: handler,
    waiterStateMachineLogOptions: {
      includeExecutionData: true,
      level: LogLevel.ALL,
    },
  })).toThrow(/\"queryInterval\", \"totalTimeout\", \"waiterStateMachineLogOptions\", and \"disableWaiterStateMachineLogging\" can only be configured if \"isCompleteHandler\" is specified. Otherwise, they have no meaning/);

  expect(() => new cr.Provider(stack, 'provider4', {
    onEventHandler: handler,
    disableWaiterStateMachineLogging: false,
  })).toThrow(/\"queryInterval\", \"totalTimeout\", \"waiterStateMachineLogOptions\", and \"disableWaiterStateMachineLogging\" can only be configured if \"isCompleteHandler\" is specified. Otherwise, they have no meaning/);
});

test('Log level are set to FATAL by default', () => {
  // GIVEN
  const stack = new Stack();
  const handler = new lambda.Function(stack, 'MyHandler', {
    code: new lambda.InlineCode('foo'),
    handler: 'index.onEvent',
    runtime: lambda.Runtime.NODEJS_LATEST,
  });

  // WHEN
  new cr.Provider(stack, 'MyProvider', {
    onEventHandler: handler,
    isCompleteHandler: handler,
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::StepFunctions::StateMachine', {
    LoggingConfiguration: Match.absent(),
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onEvent',
    Timeout: 900,
    LoggingConfig: {
      ApplicationLogLevel: 'FATAL',
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.isComplete',
    Timeout: 900,
    LoggingConfig: {
      ApplicationLogLevel: 'FATAL',
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'framework.onTimeout',
    Timeout: 900,
    LoggingConfig: {
      ApplicationLogLevel: 'FATAL',
    },
  });
});

test('uses loggingFormat instead of deprecated logFormat', () => {
  // GIVEN
  // Spy on console.warn to check for deprecation warnings
  // eslint-disable-next-line no-console
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

  const stack = new Stack();
  const handler = new lambda.Function(stack, 'MyHandler', {
    code: new lambda.InlineCode('foo'),
    handler: 'index.onEvent',
    runtime: lambda.Runtime.NODEJS_LATEST,
  });

  try {
    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: handler,
    });

    // THEN
    // Check that no deprecation warnings related to logFormat were emitted
    const deprecationWarnings = warnSpy.mock.calls
      .filter(args => typeof args[0] === 'string' && args[0].includes('logFormat is deprecated'));

    expect(deprecationWarnings.length).toBe(0);
  } finally {
    // Clean up
    warnSpy.mockRestore();
  }
});

describe('retry policy', () => {
  const stack = new Stack();

  it('default is 30 minutes timeout in 5 second intervals', () => {
    const policy = util.calculateRetryPolicy(stack);
    expect(policy.backoffRate).toStrictEqual(1);
    expect(policy.interval && policy.interval.toSeconds()).toStrictEqual(5);
    expect(policy.maxAttempts).toStrictEqual(360);
  });

  it('if total timeout and query interval are the same we will have one attempt', () => {
    const policy = util.calculateRetryPolicy(stack, {
      totalTimeout: Duration.minutes(5),
      queryInterval: Duration.minutes(5),
    });
    expect(policy.maxAttempts).toStrictEqual(1);
  });

  it('fails if total timeout cannot be integrally divided', () => {
    expect(() => util.calculateRetryPolicy(stack, {
      totalTimeout: Duration.seconds(100),
      queryInterval: Duration.seconds(75),
    })).toThrow(/Cannot determine retry count since totalTimeout=100s is not integrally dividable by queryInterval=75s/);
  });

  it('fails if interval > timeout', () => {
    expect(() => util.calculateRetryPolicy(stack, {
      totalTimeout: Duration.seconds(5),
      queryInterval: Duration.seconds(10),
    })).toThrow(/Cannot determine retry count since totalTimeout=5s is not integrally dividable by queryInterval=10s/);
  });
});

describe('log retention', () => {
  it('includes a log rotation lambda when present', () => {
    // GIVEN
    const stack = new Stack();

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'MyHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('Custom::LogRetention', {
      LogGroupName: {
        'Fn::Join': [
          '',
          [
            '/aws/lambda/',
            {
              Ref: 'MyProviderframeworkonEvent9AF5C387',
            },
          ],
        ],
      },
      RetentionInDays: 7,
    });
  });

  it('does not include the log rotation lambda otherwise', () => {
    // GIVEN
    const stack = new Stack();

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'MyHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
    });

    // THEN
    Template.fromStack(stack).resourceCountIs('Custom::LogRetention', 0);
  });
});

it('can specify log group', () => {
  // GIVEN
  const stack = new Stack();

  // WHEN
  new cr.Provider(stack, 'MyProvider', {
    onEventHandler: new lambda.Function(stack, 'MyHandler', {
      code: new lambda.InlineCode('foo'),
      handler: 'index.onEvent',
      runtime: lambda.Runtime.NODEJS_LATEST,
    }),
    logGroup: new logs.LogGroup(stack, 'LogGroup', {
      logGroupName: '/test/log/group/name',
      retention: logs.RetentionDays.ONE_WEEK,
    }),
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::Logs::LogGroup', {
    LogGroupName: '/test/log/group/name',
    RetentionInDays: 7,
  });
});

describe('role', () => {
  it('uses custom role when present @aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy enabled', () => {
    // GIVEN
    const app = new App({
      context: {
        [cxapi.LAMBDA_CREATE_NEW_POLICIES_WITH_ADDTOROLEPOLICY]: true,
      },
    });
    const stack = new Stack(app);

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'MyHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      role: new iam.Role(stack, 'MyRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      }),
    });

    // THEN
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Role: {
        'Fn::GetAtt': [
          'MyRoleF48FFE04',
          'Arn',
        ],
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'MyHandler6B74D312',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'MyHandler6B74D312',
                        'Arn',
                      ],
                    },
                    ':*',
                  ],
                ],
              },
            ],
          },
        ],
        Version: '2012-10-17',
      },
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'lambda:GetFunction',
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [
                'MyHandler6B74D312',
                'Arn',
              ],
            },
          },
        ],
      },
    });
  });

  it('uses custom role when present @aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy disabled', () => {
    // GIVEN
    const app = new App({
      context: {
        [cxapi.LAMBDA_CREATE_NEW_POLICIES_WITH_ADDTOROLEPOLICY]: false,
      },
    });
    const stack = new Stack(app);

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'MyHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      role: new iam.Role(stack, 'MyRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      }),
    });

    // THEN
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Role: {
        'Fn::GetAtt': [
          'MyRoleF48FFE04',
          'Arn',
        ],
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'MyHandler6B74D312',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'MyHandler6B74D312',
                        'Arn',
                      ],
                    },
                    ':*',
                  ],
                ],
              },
            ],
          },
          {
            Action: 'lambda:GetFunction',
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [
                'MyHandler6B74D312',
                'Arn',
              ],
            },
          },
        ],
        Version: '2012-10-17',
      },
    });
  });

  it('uses default role otherwise @aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy enabled', () => {
    // GIVEN
    const app = new App({
      context: {
        [cxapi.LAMBDA_CREATE_NEW_POLICIES_WITH_ADDTOROLEPOLICY]: true,
      },
    });
    const stack = new Stack(app);

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'MyHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
    });

    // THEN
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Role: {
        'Fn::GetAtt': [
          'MyProviderframeworkonEventServiceRole8761E48D',
          'Arn',
        ],
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'MyHandler6B74D312',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'MyHandler6B74D312',
                        'Arn',
                      ],
                    },
                    ':*',
                  ],
                ],
              },
            ],
          },
        ],
        Version: '2012-10-17',
      },
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'lambda:GetFunction',
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [
                'MyHandler6B74D312',
                'Arn',
              ],
            },
          },
        ],
      },
    });
  });

  it('uses default role otherwise @aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy disabled', () => {
    // GIVEN
    const app = new App({
      context: {
        [cxapi.LAMBDA_CREATE_NEW_POLICIES_WITH_ADDTOROLEPOLICY]: false,
      },
    });
    const stack = new Stack(app);

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'MyHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
    });

    // THEN
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Role: {
        'Fn::GetAtt': [
          'MyProviderframeworkonEventServiceRole8761E48D',
          'Arn',
        ],
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'MyHandler6B74D312',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'MyHandler6B74D312',
                        'Arn',
                      ],
                    },
                    ':*',
                  ],
                ],
              },
            ],
          },
          {
            Action: 'lambda:GetFunction',
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [
                'MyHandler6B74D312',
                'Arn',
              ],
            },
          },
        ],
        Version: '2012-10-17',
      },
    });
  });

  it('cannot specify both role and framework onEvent roles', () => {
    // GIVEN
    const stack = new Stack();

    // WHEN
    expect(() => new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'OnEventHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      isCompleteHandler: new lambda.Function(stack, 'IsCompleteHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      role: new iam.Role(stack, 'MyRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.como') }),
      frameworkOnEventRole: new iam.Role(stack, 'MyRole2', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.como') }),
    })).toThrow('Cannot specify both "role" and any of "frameworkOnEventRole" or "frameworkCompleteAndTimeoutRole"');
  });

  it('cannot specify both role and framework complete/timeout roles', () => {
    // GIVEN
    const stack = new Stack();

    // WHEN
    expect(() => new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'OnEventHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      isCompleteHandler: new lambda.Function(stack, 'IsCompleteHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      role: new iam.Role(stack, 'MyRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.como') }),
      frameworkCompleteAndTimeoutRole: new iam.Role(stack, 'MyRole2', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.como') }),
    })).toThrow('Cannot specify both "role" and any of "frameworkOnEventRole" or "frameworkCompleteAndTimeoutRole"');
  });

  it('Cannot specify "frameworkCompleteAndTimeoutRole" when "isCompleteHandler" is not specified.', () => {
    // GIVEN
    const stack = new Stack();

    // WHEN
    expect(() => new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'OnEventHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      frameworkCompleteAndTimeoutRole: new iam.Role(stack, 'MyRole2', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.como') }),
    })).toThrow('Cannot specify "frameworkCompleteAndTimeoutRole" when "isCompleteHandler" is not specified.');
  });

  it('No circular dependency thrown.', () => {
    // GIVEN
    const app = new App({
      context: {
        '@aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy': false,
      },
    });
    const stack = new Stack(app);

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'OnEventHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      isCompleteHandler: new lambda.Function(stack, 'IsCompleteHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.isComplete',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      frameworkOnEventRole: new iam.Role(stack, 'MyRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.como') }),
      frameworkCompleteAndTimeoutRole: new iam.Role(stack, 'MyRole2', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.como') }),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'OnEventHandler42BEBAE0',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'OnEventHandler42BEBAE0',
                        'Arn',
                      ],
                    },
                    ':*',
                  ],
                ],
              },
            ],
          },
          {
            Action: 'lambda:GetFunction',
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [
                'OnEventHandler42BEBAE0',
                'Arn',
              ],
            },
          },
          {
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'IsCompleteHandler7073F4DA',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'IsCompleteHandler7073F4DA',
                        'Arn',
                      ],
                    },
                    ':*',
                  ],
                ],
              },
            ],
          },
          {
            Action: 'lambda:GetFunction',
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [
                'IsCompleteHandler7073F4DA',
                'Arn',
              ],
            },
          },
          {
            Action: 'states:StartExecution',
            Effect: 'Allow',
            Resource: {
              Ref: 'MyProviderwaiterstatemachineC1FBB9F9',
            },
          },
        ],
        Version: '2012-10-17',
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'OnEventHandler42BEBAE0',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'OnEventHandler42BEBAE0',
                        'Arn',
                      ],
                    },
                    ':*',
                  ],
                ],
              },
            ],
          },
          {
            Action: 'lambda:GetFunction',
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [
                'OnEventHandler42BEBAE0',
                'Arn',
              ],
            },
          },
          {
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'IsCompleteHandler7073F4DA',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'IsCompleteHandler7073F4DA',
                        'Arn',
                      ],
                    },
                    ':*',
                  ],
                ],
              },
            ],
          },
          {
            Action: 'lambda:GetFunction',
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [
                'IsCompleteHandler7073F4DA',
                'Arn',
              ],
            },
          },
        ],
        Version: '2012-10-17',
      },
    });
  });
});

describe('name', () => {
  it('uses custom name when present', () => {
    // GIVEN
    const stack = new Stack();
    const providerFunctionName = 'test-name';

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'MyHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      providerFunctionName,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: providerFunctionName,
    });
  });
});

describe('environment encryption', () => {
  it('uses custom KMS key for environment encryption when present', () => {
    // GIVEN
    const stack = new Stack();
    const key: kms.IKey = new kms.Key(stack, 'EnvVarEncryptKey', {
      description: 'sample key',
    });

    // WHEN
    new cr.Provider(stack, 'MyProvider', {
      onEventHandler: new lambda.Function(stack, 'MyHandler', {
        code: new lambda.InlineCode('foo'),
        handler: 'index.onEvent',
        runtime: lambda.Runtime.NODEJS_LATEST,
      }),
      providerFunctionEnvEncryption: key,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      KmsKeyArn: {
        'Fn::GetAtt': [
          'EnvVarEncryptKey1A7CABDB',
          'Arn',
        ],
      },
    });
  });
});
