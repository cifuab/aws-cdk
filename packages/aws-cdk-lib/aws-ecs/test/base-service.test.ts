import { Template, Match } from '../../assertions';
import * as ec2 from '../../aws-ec2';
import * as elbv2 from '../../aws-elasticloadbalancingv2';
import * as iam from '../../aws-iam';
import * as kms from '../../aws-kms';
import * as lambda from '../../aws-lambda';
import * as cdk from '../../core';
import { App, Stack } from '../../core';
import * as cxapi from '../../cx-api';
import * as ecs from '../lib';

describe('When import an ECS Service', () => {
  let stack: cdk.Stack;

  beforeEach(() => {
    stack = new cdk.Stack();
  });

  test('with serviceArnWithCluster', () => {
    // GIVEN
    const clusterName = 'cluster-name';
    const serviceName = 'my-http-service';
    const region = 'service-region';
    const account = 'service-account';
    const serviceArn = `arn:aws:ecs:${region}:${account}:service/${clusterName}/${serviceName}`;

    // WHEN
    const service = ecs.BaseService.fromServiceArnWithCluster(stack, 'Service', serviceArn);

    // THEN
    expect(service.serviceArn).toEqual(serviceArn);
    expect(service.serviceName).toEqual(serviceName);
    expect(service.env.account).toEqual(account);
    expect(service.env.region).toEqual(region);

    expect(service.cluster.clusterName).toEqual(clusterName);
    expect(service.cluster.env.account).toEqual(account);
    expect(service.cluster.env.region).toEqual(region);
  });

  test('throws an expection if no resourceName provided on fromServiceArnWithCluster', () => {
    expect(() => {
      ecs.BaseService.fromServiceArnWithCluster(stack, 'Service', 'arn:aws:ecs:service-region:service-account:service');
    }).toThrow(/Expected resource name in ARN, didn't find one: 'arn:aws:ecs:service-region:service-account:service'/);
  });

  test('throws an expection if not using cluster arn format on fromServiceArnWithCluster', () => {
    expect(() => {
      ecs.BaseService.fromServiceArnWithCluster(stack, 'Service', 'arn:aws:ecs:service-region:service-account:service/my-http-service');
    }).toThrow(/is not using the ARN cluster format/);
  });

  test('skip validation for tokenized values', () => {
    expect(() => ecs.BaseService.fromServiceArnWithCluster(stack, 'Service',
      cdk.Lazy.string({ produce: () => 'arn:aws:ecs:service-region:service-account:service' }))).not.toThrow();
  });

  test('should add a dependency on task role', () => {
    // GIVEN
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
    });
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['test:SpecialName'],
      resources: ['*'],
    }));

    // WHEN
    new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
    });

    // THEN
    Template.fromStack(stack).hasResource('AWS::ECS::Service', {
      DependsOn: [
        'FargateTaskDefTaskRoleDefaultPolicy8EB25BBD',
        'FargateTaskDefTaskRole0B257552',
      ],
    });
  });

  test('should add tls configuration to service connect service', () => {
    // GIVEN
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDef');
    const kmsKey = new kms.Key(stack, 'KmsKey');
    const role = new iam.Role(stack, 'Role', {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
    });
    taskDefinition.addContainer('Web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
      portMappings: [
        {
          name: 'api',
          containerPort: 80,
        },
      ],
    });
    const service = new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition,
    });

    // WHEN
    service.enableServiceConnect({
      services: [
        {
          tls: {
            awsPcaAuthorityArn:
              'arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/123456789012',
            kmsKey,
            role,
          },
          portMappingName: 'api',
        },
      ],
      namespace: 'test namespace',
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      ServiceConnectConfiguration: {
        Services: [
          {
            Tls: {
              IssuerCertificateAuthority: {
                AwsPcaAuthorityArn:
                  'arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/123456789012',
              },
              KmsKey: stack.resolve(kmsKey.keyArn),
              RoleArn: stack.resolve(role.roleArn),
            },
          },
        ],
      },
    });
  });

  test('throws an error when awsPcaAuthorityArn is not an ARN', () => {
    // GIVEN
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDef');
    taskDefinition.addContainer('Web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
      portMappings: [
        {
          name: 'api',
          containerPort: 80,
        },
      ],
    });

    // WHEN
    const createFargateService = () => new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition,
      serviceConnectConfiguration: {
        services: [
          {
            tls: {
              awsPcaAuthorityArn: 'invalid-arn',
            },
            portMappingName: 'api',
          },
        ],
        namespace: 'test namespace',
      },
    });

    // THEN
    expect(() => createFargateService()).toThrow(/awsPcaAuthorityArn must start with "arn:" and have at least 6 components; received invalid-arn/);
  });
});

describe('For alarm-based rollbacks', () => {
  let stack: cdk.Stack;

  beforeEach(() => {
    stack = new cdk.Stack();
  });

  test.each([
    [true, {
      Alarms: Match.absent(),
    }],
    [false, {
      Alarms: {
        AlarmNames: [],
        Enable: false,
        Rollback: false,
      },
    }],
  ])('deploymentAlarms is (not set)/(set) by default for ECS deployment controller when feature flag is enabled/disabled', (flag, settings) => {
    // GIVEN
    const app = new cdk.App({ context: { [cxapi.ECS_REMOVE_DEFAULT_DEPLOYMENT_ALARM]: flag } });
    stack = new cdk.Stack(app);
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
    });

    // WHEN
    new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const template = Template.fromStack(stack);
    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: settings,
    });
  });

  test('deploymentAlarms is set by default when deployment controller is not specified', () => {
    // GIVEN
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
    });

    // WHEN
    new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: {
        Alarms: {
          AlarmNames: [],
          Enable: false,
          Rollback: false,
        },
      },
    });
  });

  test('should omit deploymentAlarms for CodeDeploy deployment controller', () => {
    // GIVEN
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
    });

    // WHEN
    new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY,
      },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: {
        Alarms: Match.absent(),
      },
    });
  });

  test('should omit deploymentAlarms for External deployment controller', () => {
    // GIVEN
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
    });

    // WHEN
    new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.EXTERNAL,
      },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: {
        Alarms: Match.absent(),
      },
    });
  });
});

describe('When specifying a task definition revision', () => {
  let stack: cdk.Stack;

  beforeEach(() => {
    stack = new cdk.Stack();
  });

  test('specifies the revision if set to something other than latest', () => {
    // GIVEN
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
    });

    // WHEN
    new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskDefinitionRevision: ecs.TaskDefinitionRevision.of(1),
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      TaskDefinition: 'FargateTaskDef:1',
    });
  });

  test('omits the revision if set to latest', () => {
    // GIVEN
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
    });

    // WHEN
    new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskDefinitionRevision: ecs.TaskDefinitionRevision.LATEST,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      TaskDefinition: 'FargateTaskDef',
    });
  });
});

test.each([
  /* breaker, flag => controller in template */
  /* Flag off => value present if circuitbreaker */
  [false, false, false],
  [true, false, true],
  /* Flag on => value never present */
  [false, true, false],
  [true, true, false],
])('circuitbreaker is %p /\\ flag is %p => DeploymentController in output: %p', (circuitBreaker, flagValue, controllerInTemplate) => {
  // GIVEN
  const app = new App({
    context: {
      '@aws-cdk/aws-ecs:disableExplicitDeploymentControllerForCircuitBreaker': flagValue,
    },
  });
  const stack = new Stack(app, 'Stack');
  const vpc = new ec2.Vpc(stack, 'Vpc');
  const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
  const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
  taskDefinition.addContainer('web', {
    image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
  });

  // WHEN
  new ecs.FargateService(stack, 'FargateService', {
    cluster,
    taskDefinition,
    circuitBreaker: circuitBreaker ? {} : undefined,
  });

  // THEN
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::ECS::Service', {
    DeploymentController: controllerInTemplate ? { Type: 'ECS' } : Match.absent(),
  });
});

test.each([
  [true, true],
  [false, false],
  [undefined, undefined],
])('circuitBreaker.enable is %p and circuitBreaker.rollback is %p', (enable, rollback) => {
  // GIVEN
  const app = new App();
  const stack = new Stack(app, 'Stack');
  const vpc = new ec2.Vpc(stack, 'Vpc');
  const cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
  const taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
  taskDefinition.addContainer('web', {
    image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
  });

  // WHEN
  new ecs.FargateService(stack, 'FargateService', {
    cluster,
    taskDefinition,
    circuitBreaker: {
      enable,
      rollback,
    },
  });

  // THEN
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::ECS::Service', {
    DeploymentConfiguration: {
      DeploymentCircuitBreaker: {
        Enable: enable ?? true,
        Rollback: rollback ?? false,
      },
    },
  });
});

describe('Blue/Green Deployment', () => {
  let stack: cdk.Stack;
  let vpc: ec2.Vpc;
  let cluster: ecs.Cluster;
  let taskDefinition: ecs.FargateTaskDefinition;

  beforeEach(() => {
    stack = new cdk.Stack();
    vpc = new ec2.Vpc(stack, 'Vpc');
    cluster = new ecs.Cluster(stack, 'EcsCluster', { vpc });
    taskDefinition = new ecs.FargateTaskDefinition(stack, 'FargateTaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
      portMappings: [{ containerPort: 80 }],
    });
  });

  test('isUsingECSDeploymentController returns true when no deployment controller is specified', () => {
    // GIVEN
    const service = new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
    });

    // THEN
    expect(service.isUsingECSDeploymentController()).toBe(true);
  });

  test('isUsingECSDeploymentController returns true when ECS deployment controller is specified', () => {
    // GIVEN
    const service = new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
    });

    // THEN
    expect(service.isUsingECSDeploymentController()).toBe(true);
  });

  test('isUsingECSDeploymentController returns false when CODE_DEPLOY deployment controller is specified', () => {
    // GIVEN
    const service = new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY,
      },
    });

    // THEN
    expect(service.isUsingECSDeploymentController()).toBe(false);
  });

  test('isUsingECSDeploymentController returns false when EXTERNAL deployment controller is specified', () => {
    // GIVEN
    const service = new ecs.FargateService(stack, 'FargateService', {
      cluster,
      taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.EXTERNAL,
      },
    });

    // THEN
    expect(service.isUsingECSDeploymentController()).toBe(false);
  });
});
