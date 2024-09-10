/*
Copyright 2024 Julio Fernandez

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import express from 'express';
import Router from 'express-promise-router';
import { AuthService, BackstageUserInfo, DiscoveryService, HttpAuthService, LoggerService, RootConfigService, UserInfoService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { UserEntity } from '@backstage/catalog-model';
import { FetchApi } from '@backstage/core-plugin-api';

// Kubelog
import { ClusterPods, PodData } from '@jfvilas/plugin-kubelog-common';
import { loadClusters } from './config';
import { KubelogStaticData } from '../model/KubelogStaticData';
import { checkNamespaceAccess, checkPodAccess, getPermissionSet, KWIRTH_SCOPE } from './permissions';

export type KubelogRouterOptions = {
  discoverySvc: DiscoveryService;
  configSvc: RootConfigService;
  loggerSvc: LoggerService;
  userInfoSvc: UserInfoService;
  authSvc: AuthService;
  httpAuthSvc: HttpAuthService;
};

/**
 * 
 * @param options core services we need for kubelog to work
 * @returns an express Router
 */
async function createRouter(options: KubelogRouterOptions): Promise<express.Router> {
    const { configSvc, loggerSvc, userInfoSvc, authSvc, httpAuthSvc, discoverySvc } = options;

    loggerSvc.info('Loading static config');

    if (!configSvc.has('kubernetes.clusterLocatorMethods')) {
        loggerSvc.error(`Kueblog will not start, there is no 'clusterLocatorMethods' defined in app-config.`);
        throw new Error('Kueblog backend will not be available.');
    }

    try {
        loadClusters(loggerSvc, configSvc);
    }
    catch (err) {
        var txt=`Errors detected reading static configuration: ${err}`;
        loggerSvc.error(txt);
        throw new Error(txt);
    }

    loggerSvc.info('Static config loaded');
    if (configSvc.subscribe) {
        configSvc.subscribe( () => {
            try {
                loggerSvc.warn('Change detected on app-config, Kubelog will update config.');
                loadClusters(loggerSvc, configSvc);
            }
            catch(err) {
                loggerSvc.error(`Errors detected reading new configuration: ${err}`);
            }
        });
    }
    else {
        loggerSvc.info('Kubelog cannot subscribe to config changes.');
    }

    const router = Router();

    router.use(express.json());

    // we need this function to be able to invoke another backend plugin passing an authorization token
    const createAuthFetchApi = (token: string): FetchApi => {
        return {
            fetch: async (input, init) => {
                init = init || {};
                init.headers = {
                ...init.headers,
                Authorization: `Bearer ${token}`,
                };
                return fetch(input, init);
            }
        }
    }

    /**
     * Invokes Kwirth to obtain a list of pods that are tagged with the kubernetes-id of the entity we are looking for.
     * @param entityName name of the tagge dentity
     * @returns a ClusterPods[] (each ClusterPods is a cluster info with a list of pods).
     */
    const getValidClusters = async (entityName:string) => {
    var clusterList:ClusterPods[]=[];

    for (const name of KubelogStaticData.clusterKubelogData.keys()) {
        var url=KubelogStaticData.clusterKubelogData.get(name)?.home as string;
        var apiKey=KubelogStaticData.clusterKubelogData.get(name)?.apiKey;
        var title=KubelogStaticData.clusterKubelogData.get(name)?.title;
        var queryUrl=url+`/managecluster/find?label=backstage.io%2fkubernetes-id&entity=${entityName}`;
        try {
            var fetchResp = await fetch (queryUrl, {headers:{'Authorization':'Bearer '+apiKey}});
            var jsonResp=await fetchResp.json();
            if (jsonResp) clusterList.push({ name, url, title, data:jsonResp });
        }
        catch (err) {
            loggerSvc.warn(`Cannot access cluster ${name} (URL: ${queryUrl}): ${err}`);
        }
    }

    return clusterList;
    }

    /**
     * This function obtains an accesskey for streaming a concrete log in a specific pod
     * @param clusterName the name of the cluster
     * @param entityName the name of the Backstage entity we are streaming for
     * @param kwirthResource the Resource ID that identifies the log we want to stream
     * @param userName the name of the Backstage user (for logging purposes inside Kwirth)
     * @returns a Kwirth accessKey
     */
    // const getAccessKey = async (clusterName:string, entityName:string, kwirthResource:string, userName:string) => {
    //     var url=KubelogStaticData.clusterKubelogData.get(clusterName)?.home as string;
    //     var apiKey=KubelogStaticData.clusterKubelogData.get(clusterName)?.apiKey;

    //     var payload={
    //         type:'volatile',
    //         resource: kwirthResource,
    //         description:`Backstage API key for user ${userName} accessing component ${entityName}`,
    //         expire:Date.now()+60*60*1000
    //     }
    //     var response=await fetch(url+'/key',{method:'POST', body:JSON.stringify(payload), headers:{'Content-Type':'application/json', Authorization:'Bearer '+apiKey}});
    //     var data=await response.json();
    //     return data.accessKey;
    // }

    const setAccessKey = async (reqScope:KWIRTH_SCOPE, cluster:ClusterPods, reqPod:PodData, entityName:string, userName:string, keyName:string) => {
        var kwirthResource=`${KWIRTH_SCOPE[reqScope]}:${reqPod.namespace}::${reqPod.name}:`;
        var url=KubelogStaticData.clusterKubelogData.get(cluster.name)?.home as string;
        var apiKey=KubelogStaticData.clusterKubelogData.get(cluster.name)?.apiKey;

        var payload={
            type:'volatile',
            resource: kwirthResource,
            description:`Backstage API key for user ${userName} accessing component ${entityName}`,
            expire:Date.now()+60*60*1000
        }
        var response=await fetch(url+'/key',{method:'POST', body:JSON.stringify(payload), headers:{'Content-Type':'application/json', Authorization:'Bearer '+apiKey}});
        var data=await response.json();
        (reqPod as any)[keyName]=data.accessKey;
    }

    /**
     * Adds access keys to the list of kubernetes resources related with the entity. Only keys where the user is permitted are added.
     * @param foundClusters current list of clusters (whcih have no access keys yet)
     * @param entityName name of the entoty we want to stream logs
     * @param userEntityRef a user entoty ref for the current user ('user:group/id')
     * @param userGroups a list of the IAM groups the user belongs to
     * @returns the cluster list populated with access keys that the user is permitted to use
     */
    const addAccessKeys = async (reqScopeStr:string, foundClusters:ClusterPods[], entityName:string, userEntityRef:string, userGroups:string[], keyName:string) => {
        var reqScope:KWIRTH_SCOPE= KWIRTH_SCOPE[reqScopeStr as keyof typeof KWIRTH_SCOPE]
        if (!reqScope) {
            console.log(`Invalid scope requested: ${reqScopeStr}`)
            return;
        }
        var principal=userEntityRef.split(':')[1]
        var username=principal.split('/')[1]

        for (var foundCluster of foundClusters) {
            console.log('TEST CLUSTER '+foundCluster.name)

            // for each pod we've found on the cluster we check all namespace permissions
            for (var podData of foundCluster.data) {
                console.log(`TEST POD ${podData.namespace}/${podData.name}`)

                console.log(`test nsaccess ${podData.namespace}`)
                // first we check if user is allowed to acccess namespace
                var allowedToNamespace=checkNamespaceAccess(foundCluster, podData, userEntityRef, userGroups)

                if (allowedToNamespace) {
                    console.log(`test podaccess ${podData.name}`)

                    // then we check if required pod namespace has pod access restriccions for requested namespace
                    var clusterDef = KubelogStaticData.clusterKubelogData.get(foundCluster.name)
                    var podPermissions=getPermissionSet(reqScope, clusterDef!)
                    if (!podPermissions) {
                        loggerSvc.warn(`Invalid scope requested: ${reqScope}`)
                        return
                    }
                    var namespaceRestricted = podPermissions.some(pp => pp.namespace===podData.namespace);
                    if (!namespaceRestricted) {
                        console.log(`podaccess: no namespace restrictions for ns ${podData.namespace}`);
                        //var kwirthResource=`${KWIRTH_SCOPE[reqScope]}:${podData.podNamespace}::${podData.podName}:`;
                        //podData.accessKey=await getAccessKey(foundCluster.name, entityName, kwirthResource, username);
                        await setAccessKey(reqScope, foundCluster, podData, entityName, username, keyName);
                    }
                    else {
                        console.log(`podaccess: namespace restricted, checking podaccess for ${podData.namespace}`)
                        // we now check pod permissions
                        var allowedToPod=checkPodAccess(loggerSvc, reqScope, foundCluster, podData, entityName, userEntityRef, userGroups)
                        if (allowedToPod) {
                            // now we ask for an accessKey for the specific scope (typically 'view' or 'restart')
                            // var kwirthResource=`${KWIRTH_SCOPE[reqScope]}:${podData.podNamespace}::${podData.podName}:`;
                            // podData.accessKey=await getAccessKey(foundCluster.name, entityName, kwirthResource, username);
                            await setAccessKey(reqScope, foundCluster, podData, entityName, username, keyName);
                        }
                    }
                }
                else {
                    // user is not allowed to namespace, so don't need to check pod permissions, we finish
                    console.log('nsaccess: user not allowed --> NOADDEDKEYS')
                    break;
                }
            }
        }
    }

    /**
     * builds a list of groups (expressed as identity refs) that the user belongs to.
     * @param userInfo Backstage user info of the user to search groups for
     * @returns an array of group refs in canonical form
     */
    const getUserGroups = async (userInfo:BackstageUserInfo) => {
        const { token } = await authSvc.getPluginRequestToken({
            onBehalfOf: await authSvc.getOwnServiceCredentials(),
            targetPluginId: 'catalog'
        });
        const catalogClient = new CatalogClient({
            discoveryApi: discoverySvc,
            fetchApi: createAuthFetchApi(token),
        });

        const entity = await catalogClient.getEntityByRef(userInfo.userEntityRef) as UserEntity;
        var userGroupsRefs:string[]=[];
        //+++ future use: recursive memberOf
        if (entity?.spec.memberOf) userGroupsRefs=entity?.spec.memberOf;
        return userGroupsRefs;
    }

    const processStart = async (req:any, res:any) => {
        // obtain basic user info
        const credentials = await httpAuthSvc.credentials(req, { allow: ['user'] });
        const userInfo = await userInfoSvc.getUserInfo(credentials);
    
        // get user groups list
        var userGroupsRefs=await getUserGroups(userInfo);
        console.log('USER DATA');
        console.log(userInfo.userEntityRef);
        console.log(userGroupsRefs);
    
        // get a list of clusters that contain pods related to entity
        //+++ control errors here (maybe we cannot conntact the cluster, for example)
        var foundClusters:ClusterPods[]=await getValidClusters(req.body.metadata.name);
    
        // add access keys to authorized resources (according to group memberships and kubelog config in app-config (namespace and pod permissions))
        await addAccessKeys('view', foundClusters, req.body.metadata.name, userInfo.userEntityRef, userGroupsRefs, 'accessKey');
    
        res.status(200).send(foundClusters);
    }

    const processAccess = async (req:express.Request, res:express.Response) => {
        if (!req.query['scopes']) {
            res.status(400).send();
            return;
        }
        var reqScopes = (req.query['scopes'].toString()).split(',');
    
        // obtain basic user info
        const credentials = await httpAuthSvc.credentials(req, { allow: ['user'] });
        const userInfo = await userInfoSvc.getUserInfo(credentials);
        // get user groups list
        var userGroupsRefs=await getUserGroups(userInfo);
    
        // get a list of clusters that contain pods related to entity
        //+++ control errors here (maybe we cannot conntact the cluster, for example)
        var foundClusters:ClusterPods[]=await getValidClusters(req.body.metadata.name);
    
        // add access keys to authorized resources (according to group membership and kubelog config in app-config (namespace and pod permissions))
        for (var reqScopeStr of reqScopes) {
            await addAccessKeys(reqScopeStr, foundClusters, req.body.metadata.name, userInfo.userEntityRef, userGroupsRefs, reqScopeStr+'AccessKey');
        }
    
        res.status(200).send(foundClusters);
    }

    // this endpoints receives entity from the kubelog plugin and builds a list of resurces with api keys
    router.post(['/start'], (req, res) => {
        //+++ warn only once
        loggerSvc.warn('Endpoint "/start" is deprecated, update your "plugin-kubelog" package to 0.9.0 or later before 2025-08-25.');
        processStart(req,res);
    });

    router.post(['/access'], (req, res) => {
        processAccess(req,res);
    });

    return router;
}

export { createRouter }
