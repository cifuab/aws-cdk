import { Construct } from 'constructs';
import * as appscaling from '../../../aws-applicationautoscaling';
import * as ec2 from '../../../aws-ec2';
import * as elbv2 from '../../../aws-elasticloadbalancingv2';
import * as cloudmap from '../../../aws-servicediscovery';
import { ArnFormat, Resource, Stack, Annotations, ValidationError } from '../../../core';
import { addConstructMetadata, MethodMetadata } from '../../../core/lib/metadata-resource';
import { propertyInjectable } from '../../../core/lib/prop-injectable';
import { IAlternateTarget } from '../alternate-target-configuration';
import { AssociateCloudMapServiceOptions, BaseService, BaseServiceOptions, CloudMapOptions, DeploymentControllerType, EcsTarget, IBaseService, IEcsLoadBalancerTarget, IService, LaunchType, PropagatedTagSource } from '../base/base-service';
import { fromServiceAttributes } from '../base/from-service-attributes';
import { ScalableTaskCount } from '../base/scalable-task-count';
import { Compatibility, LoadBalancerTargetOptions, TaskDefinition } from '../base/task-definition';
import { ICluster } from '../cluster';

/**
 * The properties for defining a service using the External launch type.
 */
export interface ExternalServiceProps extends BaseServiceOptions {
  /**
   * The task definition to use for tasks in the service.
   *
   * [disable-awslint:ref-via-interface]
   */
  readonly taskDefinition: TaskDefinition;

  /**
   * The security groups to associate with the service. If you do not specify a security group, a new security group is created.
   *
   *
   * @default - A new security group is created.
   */
  readonly securityGroups?: ec2.ISecurityGroup[];

  /**
   * By default, service use REPLICA scheduling strategy, this parameter enable DAEMON scheduling strategy.
   * If true, the service scheduler deploys exactly one task on each container instance in your cluster.
   *
   * When you are using this strategy, do not specify a desired number of tasks or any task placement strategies.
   * Tasks using the Fargate launch type or the CODE_DEPLOY or EXTERNAL deployment controller types don't support the DAEMON scheduling strategy.
   *
   * @default false
   */
  readonly daemon?: boolean;
}

/**
 * The interface for a service using the External launch type on an ECS cluster.
 */
export interface IExternalService extends IService {

}

/**
 * The properties to import from the service using the External launch type.
 */
export interface ExternalServiceAttributes {
  /**
   * The cluster that hosts the service.
   */
  readonly cluster: ICluster;

  /**
   * The service ARN.
   *
   * @default - either this, or `serviceName`, is required
   */
  readonly serviceArn?: string;

  /**
   * The name of the service.
   *
   * @default - either this, or `serviceArn`, is required
   */
  readonly serviceName?: string;
}

/**
 * This creates a service using the External launch type on an ECS cluster.
 *
 * @resource AWS::ECS::Service
 */
@propertyInjectable
export class ExternalService extends BaseService implements IExternalService {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-ecs.ExternalService';

  /**
   * Imports from the specified service ARN.
   */
  public static fromExternalServiceArn(scope: Construct, id: string, externalServiceArn: string): IExternalService {
    class Import extends Resource implements IExternalService {
      public readonly serviceArn = externalServiceArn;
      public readonly serviceName = Stack.of(scope).splitArn(externalServiceArn, ArnFormat.SLASH_RESOURCE_NAME).resourceName as string;
    }
    return new Import(scope, id);
  }

  /**
   * Imports from the specified service attributes.
   */
  public static fromExternalServiceAttributes(scope: Construct, id: string, attrs: ExternalServiceAttributes): IBaseService {
    return fromServiceAttributes(scope, id, attrs);
  }

  /**
   * Constructs a new instance of the ExternalService class.
   */
  constructor(scope: Construct, id: string, props: ExternalServiceProps) {
    if (props.daemon) {
      if (props.deploymentController?.type === DeploymentControllerType.EXTERNAL ||
        props.deploymentController?.type === DeploymentControllerType.CODE_DEPLOY) {
        throw new ValidationError('CODE_DEPLOY or EXTERNAL deployment controller types don\'t support the DAEMON scheduling strategy.', scope);
      }
      if (props.desiredCount !== undefined) {
        throw new ValidationError('Daemon mode launches one task on every instance. Cannot specify desiredCount when daemon mode is enabled.', scope);
      }
      if (props.maxHealthyPercent !== undefined && props.maxHealthyPercent !== 100) {
        throw new ValidationError('Maximum percent must be 100 when daemon mode is enabled.', scope);
      }
    }

    if (props.minHealthyPercent !== undefined && props.maxHealthyPercent !== undefined && props.minHealthyPercent >= props.maxHealthyPercent) {
      throw new ValidationError('Minimum healthy percent must be less than maximum healthy percent.', scope);
    }

    if (props.taskDefinition.compatibility !== Compatibility.EXTERNAL) {
      throw new ValidationError('Supplied TaskDefinition is not configured for compatibility with ECS Anywhere cluster', scope);
    }

    if (props.cluster.defaultCloudMapNamespace !== undefined) {
      throw new ValidationError(`Cloud map integration is not supported for External service ${props.cluster.defaultCloudMapNamespace}`, scope);
    }

    if (props.cloudMapOptions !== undefined) {
      throw new ValidationError('Cloud map options are not supported for External service', scope);
    }

    if (props.capacityProviderStrategies !== undefined) {
      throw new ValidationError('Capacity Providers are not supported for External service', scope);
    }

    const propagateTagsFromSource = props.propagateTags ?? PropagatedTagSource.NONE;

    super(scope, id, {
      ...props,
      desiredCount: props.desiredCount,
      maxHealthyPercent: props.maxHealthyPercent === undefined ? 100 : props.maxHealthyPercent,
      minHealthyPercent: props.minHealthyPercent === undefined ? 0 : props.minHealthyPercent,
      launchType: LaunchType.EXTERNAL,
      propagateTags: propagateTagsFromSource,
      enableECSManagedTags: props.enableECSManagedTags,
    },
    {
      cluster: props.cluster.clusterName,
      taskDefinition: props.deploymentController?.type === DeploymentControllerType.EXTERNAL ? undefined : props.taskDefinition.taskDefinitionArn,
      schedulingStrategy: props.daemon ? 'DAEMON' : undefined,
    }, props.taskDefinition);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    this.node.addValidation({
      validate: () => !this.taskDefinition.defaultContainer ? ['A TaskDefinition must have at least one essential container'] : [],
    });

    this.node.addValidation({
      validate: () => this.networkConfiguration !== undefined ? ['Network configurations not supported for an external service'] : [],
    });

    if (props.minHealthyPercent === undefined) {
      Annotations.of(this).addWarningV2('@aws-cdk/aws-ecs:minHealthyPercentExternal', 'minHealthyPercent has not been configured so the default value of 0% for an external service is used. The number of running tasks will decrease below the desired count during deployments etc. See https://github.com/aws/aws-cdk/issues/31705');
    }
  }

  /**
   * Overridden method to throw error as `attachToApplicationTargetGroup` is not supported for external service
   */
  @MethodMetadata()
  public attachToApplicationTargetGroup(_targetGroup: elbv2.IApplicationTargetGroup): elbv2.LoadBalancerTargetProps {
    throw new ValidationError('Application load balancer cannot be attached to an external service', this);
  }

  /**
   * Overridden method to throw error as `loadBalancerTarget` is not supported for external service
   */
  @MethodMetadata()
  public loadBalancerTarget(_options: LoadBalancerTargetOptions, _alternateOptions?: IAlternateTarget): IEcsLoadBalancerTarget {
    throw new ValidationError('External service cannot be attached as load balancer targets', this);
  }

  /**
   * Overridden method to throw error as `registerLoadBalancerTargets` is not supported for external service
   */
  @MethodMetadata()
  public registerLoadBalancerTargets(..._targets: EcsTarget[]) {
    throw new ValidationError('External service cannot be registered as load balancer targets', this);
  }

  /**
   * Overridden method to throw error as `configureAwsVpcNetworkingWithSecurityGroups` is not supported for external service
   */
  // eslint-disable-next-line max-len, no-unused-vars
  protected configureAwsVpcNetworkingWithSecurityGroups(_vpc: ec2.IVpc, _assignPublicIp?: boolean, _vpcSubnets?: ec2.SubnetSelection, _securityGroups?: ec2.ISecurityGroup[]) {
    throw new ValidationError('Only Bridge network mode is supported for external service', this);
  }

  /**
   * Overridden method to throw error as `autoScaleTaskCount` is not supported for external service
   */
  @MethodMetadata()
  public autoScaleTaskCount(_props: appscaling.EnableScalingProps): ScalableTaskCount {
    throw new ValidationError('Autoscaling not supported for external service', this);
  }

  /**
   * Overridden method to throw error as `enableCloudMap` is not supported for external service
   */
  @MethodMetadata()
  public enableCloudMap(_options: CloudMapOptions): cloudmap.Service {
    throw new ValidationError('Cloud map integration not supported for an external service', this);
  }

  /**
   * Overridden method to throw error as `associateCloudMapService` is not supported for external service
   */
  @MethodMetadata()
  public associateCloudMapService(_options: AssociateCloudMapServiceOptions): void {
    throw new ValidationError('Cloud map service association is not supported for an external service', this);
  }
}
