/*
Copyright 2024 Julio Fernandez

Licensed under the Apache License, Version 2.0 (the "License")
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { LoggerService, RootConfigService } from '@backstage/backend-plugin-api'
import { KubelogStaticData, MIN_KWIRTH_VERSION } from '../model/KubelogStaticData'
import { KubelogClusterData, KubelogPodPermissions, PodPermissionRule } from '../model/KubelogClusterData'
import { Config } from '@backstage/config'
import { ClusterTypeEnum, KwirthData, versionGreatOrEqualThan } from '@jfvilas/kwirth-common'

/**
 * loads kubelogNamespacePermissions setting from app-config xml
 * @param logger Logger service
 * @param cluster Cluster config as it is read form app-config
 * @param kdata KwirtClusterData being processed
 */
const loadNamespacePermissions = (logger:LoggerService, cluster:Config, kdata:KubelogClusterData) => {
    if (cluster.has('kubelogNamespacePermissions')) {
        logger.info(`Namespace permisson evaluation will be performed for cluster ${cluster.getString('name')}.`)
        var permNamespaces= (cluster.getOptionalConfigArray('kubelogNamespacePermissions'))!
        for (var ns of permNamespaces) {
            var namespace=ns.keys()[0]
            var identityRefs=ns.getStringArray(namespace)
            identityRefs=identityRefs.map(g => g.toLowerCase())
            kdata.namespacePermissions.push ({ namespace, identityRefs })
        }
    }
    else {
        logger.info(`Cluster ${cluster.getString('name')} will have no namespace restrictions.`)
        kdata.namespacePermissions=[]
    }
}

const loadPodRules = (config:Config, id:string) => {
    var rules:PodPermissionRule[]=[]
    for (var rule of config.getConfigArray(id)) {
        var podsStringArray = rule.getOptionalStringArray('pods') || ['.*']
        var podsRegexArray:RegExp[]=[]
        for (var expr of podsStringArray) {
            podsRegexArray.push(new RegExp(expr))
        }

        var refsStringArray = rule.getOptionalStringArray('refs') || ['.*']
        var refsRegexArray:RegExp[]=[]
        for (var expr of refsStringArray) {
            refsRegexArray.push(new RegExp(expr))
        }

        var prr:PodPermissionRule={
            pods:podsRegexArray,
            refs:refsRegexArray
        }
        rules.push(prr)
    }
    return rules
}

/**
 * loads pod log viewing permissions setting from app-config xml
 * @param configKey then name of the key (inside app-config) to read config from
 * @param logger Logger service
 * @param cluster Cluster config as it is read form app-config
 */
const loadPodPermissions = (configKey:string, logger:LoggerService, cluster:Config) => {
    var clusterPodPermissions:KubelogPodPermissions[]=[]
    if (cluster.has(configKey)) {
        var namespaceList=cluster.getConfigArray(configKey)
        for (var ns of namespaceList) {
            var namespaceName=ns.keys()[0]
            var podPermissions:KubelogPodPermissions={ namespace:namespaceName }

            if (ns.getConfig(namespaceName).has('allow')) {
                podPermissions.allow=loadPodRules(ns.getConfig(namespaceName), 'allow')
                if (ns.getConfig(namespaceName).has('except')) podPermissions.except=loadPodRules(ns.getConfig(namespaceName), 'except')
                if (ns.getConfig(namespaceName).has('deny')) podPermissions.deny=loadPodRules(ns.getConfig(namespaceName), 'deny')
                if (ns.getConfig(namespaceName).has('unless')) podPermissions.unless=loadPodRules(ns.getConfig(namespaceName), 'unless')
            }
            else {
                podPermissions.allow=[]
                podPermissions.allow.push({
                    pods: [new RegExp('.*')],
                    refs: [new RegExp('.*')]
                })
            }
            clusterPodPermissions.push(podPermissions)
        }
    }
    else {
        logger.info(`No pod permissions for ${configKey} will be applied for ${cluster.getString('name')} (everyone will be allowed).`)
    }
    return clusterPodPermissions
}

/**
 * reads app-config and builds a list of valid clusters
 * @param logger core service for logging
 * @param config core service for reading config info
 */
const loadClusters = async (logger:LoggerService, config:RootConfigService) => {
    KubelogStaticData.clusterKubelogData.clear()

    var locatingMethods=config.getConfigArray('kubernetes.clusterLocatorMethods')
    for (var method of locatingMethods) {

      var clusters=(method.getConfigArray('clusters'))
      for (var cluster of clusters) {

        var name=cluster.getString('name')
        if (cluster.has('kubelogKwirthHome') && cluster.has('kubelogKwirthApiKey')) {   
            var home:string = (cluster.getOptionalString('kwirthHome') || cluster.getOptionalString('kubelogKwirthHome'))!
            var apiKeyStr:string = (cluster.getOptionalString('kwirthApiKey') || cluster.getOptionalString('kubelogKwirthApiKey'))!
            var title:string = (cluster.has('title')?cluster.getString('title'):'No name')
            var kubelogClusterData:KubelogClusterData={
                name,
                kwirthHome: home,
                kwirthApiKey: apiKeyStr,
                kwirthData: {
                    version: '',
                    clusterName: '',
                    inCluster: false,
                    namespace: '',
                    deployment: '',
                    lastVersion: '',
                    clusterType: ClusterTypeEnum.KUBERNETES,
                    metricsInterval: 0,
                    channels: []
                },
                title,
                namespacePermissions: [],
                viewPermissions: [],
                restartPermissions: [],
                enabled: false
            }

            logger.info(`Kwirth for ${name} is located at ${kubelogClusterData.kwirthHome}. Testing connection...`)
            let enableCluster = false
            try {
                /*
                    /config/info endpoint returns JSON:
                    {
                        "clusterName": "inCluster",
                        "namespace": "default",
                        "deployment": "kwirth",
                        "inCluster": true,
                        "version": "0.4.11",
                        "lastVersion": "0.4.11",
                        "clusterType": "kubernetes",
                        "metricsInterval": 60,
                        "channels": [
                            {
                                "id": "log",
                                "routable": false,
                                "pauseable": true,
                                "modifyable": false,
                                "reconnectable": true,
                                "sources": [
                                    "docker",
                                    "kubernetes"
                                ],
                                "metrics": false
                            },
                            {
                                "id": "alert",
                                "routable": false,
                                "pauseable": true,
                                "modifyable": false,
                                "reconnectable": true,
                                "sources": [
                                    "docker",
                                    "kubernetes"
                                ],
                                "metrics": false
                            },
                            {
                                "id": "metrics",
                                "routable": false,
                                "pauseable": true,
                                "modifyable": true,
                                "reconnectable": true,
                                "sources": [
                                    "kubernetes"
                                ],
                                "metrics": true
                            },
                            {
                                "id": "ops",
                                "routable": true,
                                "pauseable": false,
                                "modifyable": false,
                                "reconnectable": false,
                                "sources": [
                                    "kubernetes"
                                ],
                                "metrics": false
                            },
                            {
                                "id": "trivy",
                                "routable": false,
                                "pauseable": false,
                                "modifyable": false,
                                "reconnectable": false,
                                "sources": [
                                    "kubernetes"
                                ],
                                "metrics": false
                            },
                            {
                                "id": "echo",
                                "routable": false,
                                "pauseable": true,
                                "modifyable": false,
                                "reconnectable": true,
                                "metrics": false,
                                "sources": [
                                    "kubernetes",
                                    "docker"
                                ]
                            }
                        ]
                    }                
                */
                var response = await fetch (kubelogClusterData.kwirthHome+'/config/info')
                try {
                    var data = await response.text()
                    try {
                        var kwirthData=JSON.parse(data) as KwirthData
                        logger.info(`Kwirth info at cluster '${kubelogClusterData.name}': ${JSON.stringify(kwirthData)}`)
                        kubelogClusterData.kwirthData=kwirthData
                        if (versionGreatOrEqualThan(kwirthData.version, MIN_KWIRTH_VERSION)) {
                            enableCluster = true
                        }
                        else {
                            logger.error(`Unsupported Kwirth version on cluster '${name}' (${title}) [${kwirthData.version}]. Min version is ${MIN_KWIRTH_VERSION}`)
                        }
                    }
                    catch (err) {
                        logger.error(`Kwirth at cluster ${kubelogClusterData.name} returned errors: ${err}`)
                        logger.info('Returned data is:')
                        logger.info(data)
                        kubelogClusterData.kwirthData = {
                            version:'0.0.0',
                            clusterName:'unknown',
                            inCluster:false,
                            namespace:'unknown',
                            deployment:'unknown',
                            lastVersion:'0.0.0',
                            clusterType: ClusterTypeEnum.KUBERNETES,
                            metricsInterval: 0,
                            channels: []
                        }
                    }
                }
                catch (err) {
                    logger.warn(`Error parsing version response from cluster '${kubelogClusterData.name}': ${err}`)
                }
            }
            catch (err) {
                logger.info(`Kwirth access error: ${err}.`)
                logger.warn(`Kwirth home URL (${kubelogClusterData.kwirthHome}) at cluster '${kubelogClusterData.name}' cannot be accessed right now.`)
            }

            if (enableCluster) {
                // we now read and format permissions according to destination structure inside KubelogClusterData
                loadNamespacePermissions(logger, cluster, kubelogClusterData)
                kubelogClusterData.viewPermissions=loadPodPermissions('kubelogPodViewPermissions',logger, cluster)
                kubelogClusterData.restartPermissions=loadPodPermissions('kubelogPodRestartPermissions', logger, cluster)
                KubelogStaticData.clusterKubelogData.set(name, kubelogClusterData)
            }
        }
        else {
            logger.warn(`Cluster ${name} has no Kubelog information (kubelogHome and kubelogApiKey are missing). It will not be used for Kubelog log viewing.`)
        }
      }
    }
    console.log(KubelogStaticData.clusterKubelogData)
}

export { loadClusters }