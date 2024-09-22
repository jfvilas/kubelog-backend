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
import { ClusterValidPods, PodData } from '@jfvilas/plugin-kubelog-common';
import { loadClusters } from './config';
import { KubelogStaticData, VERSION } from '../model/KubelogStaticData';
import { checkNamespaceAccess, checkPodAccess, getPodPermissionSet, KWIRTH_SCOPE } from './permissions';

export type KubelogRouterOptions = {
  discoverySvc: DiscoveryService;
  configSvc: RootConfigService;
  loggerSvc: LoggerService;
  userInfoSvc: UserInfoService;
  authSvc: AuthService;
  httpAuthSvc: HttpAuthService;
};

const DEBUG=undefined
const debug = (a:any)  => {
    if (DEBUG) console.log(a);
}

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
     * @returns a ClusterValidPods[] (each ClusterValidPods is a cluster info with a list of pods tagged with the entityName).
     */
    const getValidClusters = async (entityName:string) => {
        var clusterList:ClusterValidPods[]=[];

        for (const name of KubelogStaticData.clusterKubelogData.keys()) {
            var url=KubelogStaticData.clusterKubelogData.get(name)?.kwirthHome as string;
            var apiKeyStr=KubelogStaticData.clusterKubelogData.get(name)?.kwirthApiKeyStr;
            var title=KubelogStaticData.clusterKubelogData.get(name)?.title;
            var queryUrl=url+`/managecluster/find?label=backstage.io%2fkubernetes-id&entity=${entityName}`
            try {
                var fetchResp = await fetch (queryUrl, {headers:{'Authorization':'Bearer '+apiKeyStr}})
                if (fetchResp.status===200) {
                    var jsonResp=await fetchResp.json()
                    if (jsonResp) clusterList.push({ name, url, title, data:jsonResp })
                }
                else {
                    loggerSvc.warn(`Invalid response from cluster ${name}: ${fetchResp.status}`)
                    clusterList.push({ name, url, title, data:[] })
                }

            }
            catch (err) {
                loggerSvc.warn(`Cannot access cluster ${name} (URL: ${queryUrl}): ${err}`)
                clusterList.push({ name, url, title, data:[] })
            }
        }

        return clusterList;
    }

    /**
     * This function obtains an accesskey for streaming a concrete log in a specific pod
     * @param reqScope the scope (view, restart...) that the user is requesting
     * @param cluster the cluster where the pod has been found
     * @param reqPod the pod that the user is requesting access to
     * @param entityName the name of the Backstage entity we are streaming for
     * @param userName the id of the user (not a canonical identityRef, just the user id)
     * @param keyName the name of the key inside the json where the accessKey must be set (typically, 'view', 'restart', etc...)
     * @returns nothing (this function just set an accessKey in a property of the reqPod)
     */
    const setAccessKey = async (reqScope:KWIRTH_SCOPE, cluster:ClusterValidPods, reqPod:PodData, entityName:string, userName:string, keyName:string) => {
        var kwirthResource=`${KWIRTH_SCOPE[reqScope]}:${reqPod.namespace}::${reqPod.name}:`;
        var url=KubelogStaticData.clusterKubelogData.get(cluster.name)?.kwirthHome as string;
        var apiKeyStr=KubelogStaticData.clusterKubelogData.get(cluster.name)?.kwirthApiKeyStr;

        var payload={
            type:'volatile',
            resource: kwirthResource,
            description:`Backstage API key for user ${userName} accessing component ${entityName}`,
            expire:Date.now()+60*60*1000
        }
        var fetchResp=await fetch(url+'/key',{method:'POST', body:JSON.stringify(payload), headers:{'Content-Type':'application/json', Authorization:'Bearer '+apiKeyStr}});
        if (fetchResp.status===200) {
            var data=await fetchResp.json();
            (reqPod as any)[keyName]=data.accessKey;
        }
        else {
            loggerSvc.warn(`Invalid response obtaining key from cluster ${cluster.name}: ${fetchResp.status}`)
        }
    }

    /**
     * Adds access keys to the list of kubernetes resources related with the entity. Only keys where the user is permitted are added.
     * @param reqScopeStr is the string with the scope requestied ('view', 'restart'...)
     * @param foundClusters current list of clusters (which have no access keys yet)
     * @param entityName name of the entity we want to stream logs
     * @param userEntityRef a user entoty ref for the current user ('user:group/id')
     * @param userGroups a list of the IAM groups the user belongs to
     * @param keyName the name of the key inside the json where the accessKey must be set (typically, 'view', 'restart', etc...)
     * @returns nothing (this function populate the foundClusters list with access keys that the user is allowed to use)
     */
    const addAccessKeys = async (reqScopeStr:string, foundClusters:ClusterValidPods[], entityName:string, userEntityRef:string, userGroups:string[], keyName:string) => {
        var reqScope:KWIRTH_SCOPE= KWIRTH_SCOPE[reqScopeStr as keyof typeof KWIRTH_SCOPE]
        if (!reqScope) {
            loggerSvc.info(`Invalid scope requested: ${reqScopeStr}`)
            return;
        }
        var principal=userEntityRef.split(':')[1]
        var username=principal.split('/')[1]

        for (var foundCluster of foundClusters) {
            debug('')
            debug('')
            debug('')
            debug('cluster '+foundCluster.name)
            debug('podDataLength '+foundCluster.data.length)
            // for each pod we've found on the cluster we check all namespace permissions
            for (var podData of foundCluster.data) {
                // first we check if user is allowed to acccess namespace
                debug('>>> CNA ')
                var allowedToNamespace=checkNamespaceAccess(foundCluster, podData, userEntityRef, userGroups)
                debug('<<< CNA '+allowedToNamespace)

                if (allowedToNamespace) {

                    // then we check if required pod namespace has pod access restriccions for requested namespace
                    var clusterDef = KubelogStaticData.clusterKubelogData.get(foundCluster.name)
                    var podPermissionSet=getPodPermissionSet(reqScope, clusterDef!)
                    if (!podPermissionSet) {
                        loggerSvc.warn(`Pod permission set not found: ${reqScope}`)
                        return
                    }
                    var namespaceRestricted = podPermissionSet.some(pp => pp.namespace===podData.namespace);
                    if (!namespaceRestricted) {
                        // there are no namespace restrictions specified in the pod permission set
                        await setAccessKey(reqScope, foundCluster, podData, entityName, username, keyName);
                    }
                    else {
                        // we now check pod permission set
                        var allowedToPod=checkPodAccess(loggerSvc, foundCluster, podData, podPermissionSet, entityName, userEntityRef, userGroups)
                        if (allowedToPod) {
                            // now we ask for an accessKey for the specific scope (typically 'view' or 'restart')
                            await setAccessKey(reqScope, foundCluster, podData, entityName, username, keyName);
                        }
                    }
                }
                else {
                    // user is not allowed to namespace, so we don't need to check pod permissions
                    // the loop cotinues with other pods
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

    // this is and API endpoint controller
    const processStart = async (req:any, res:any) => {
        // obtain basic user info
        const credentials = await httpAuthSvc.credentials(req, { allow: ['user'] });
        const userInfo = await userInfoSvc.getUserInfo(credentials);
    
        // get user groups list
        var userGroupsRefs=await getUserGroups(userInfo);
    
        // get a list of clusters that contain pods related to entity
        //+++ control errors here (maybe we cannot contact the cluster, for example)
        var foundClusters:ClusterValidPods[]=await getValidClusters(req.body.metadata.name);
    
        // add access keys to authorized resources (according to group memberships and kubelog config in app-config (namespace and pod permissions))
        await addAccessKeys('view', foundClusters, req.body.metadata.name, userInfo.userEntityRef, userGroupsRefs, 'accessKey');
    
        res.status(200).send(foundClusters);
    }

    // this is and API endpoint controller
    const processVersion = async (_req:any, res:any) => {
        res.status(200).send({ version:VERSION });
    }

    // this is and API endpoint controller
    const processAccess = async (req:express.Request, res:express.Response) => {
        if (!req.query['scopes']) {
            res.status(400).send()
            return
        }
        var reqScopes = (req.query['scopes'].toString()).split(',')
    
        // obtain basic user info
        const credentials = await httpAuthSvc.credentials(req, { allow: ['user'] })
        const userInfo = await userInfoSvc.getUserInfo(credentials)
        // get user groups list
        var userGroupsRefs=await getUserGroups(userInfo)

        loggerSvc.info(`Checking reqScopes '${req.query['scopes']}' scopes to pod: '${req.body.metadata.namespace+'/'+req.body.metadata.name}' for user '${userInfo.userEntityRef}'`)

        // get a list of clusters that contain pods related to entity
        //+++ control errors here (maybe we cannot conntact the cluster, for example)
        var foundClusters:ClusterValidPods[]=await getValidClusters(req.body.metadata.name)
        debug('foundClusters')
        debug(foundClusters)
        // add access keys to authorized resources (according to group membership and kubelog config in app-config (namespace and pod permissions))
        for (var reqScopeStr of reqScopes) {
            debug('')
            debug('')
            debug('')
            debug('******************************')
            debug('******** SCOPE '+reqScopeStr)
            debug('******************************')
            await addAccessKeys(reqScopeStr, foundClusters, req.body.metadata.name, userInfo.userEntityRef, userGroupsRefs, reqScopeStr+'AccessKey')
        }
    
        res.status(200).send(foundClusters)
    }

    // this endpoints receives entity from the kubelog plugin and builds a list of resurces with api keys
    router.post(['/start'], (req, res) => {
        //+++ warn only once
        loggerSvc.warn('Endpoint "/start" is deprecated. Please update your front-end "plugin-kubelog" package to 0.9.2 or later before 2025-08-25.')
        processStart(req,res)
    })

    router.post(['/access'], (req, res) => {
        processAccess(req,res)
    })

    router.get(['/version'], (req, res) => {
        processVersion(req,res)
    })

    return router
}

export { createRouter }
